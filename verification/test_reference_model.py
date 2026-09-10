from dataclasses import replace
from itertools import product
from pathlib import Path
import json
import tempfile
import unittest
from reference_model import Denied, Document, Policy, Request, Draft, Outbox, Inbox, materialize


def fixture():
    members=frozenset((p,s) for p in ('ana','bruno','admin') for s in ('A','B'))
    grants=frozenset({('ana','A','search'),('ana','A','receive'),('bruno','A','read'),
                      ('bruno','A','share'),('bruno','A','manage'),('admin','A','manage')})
    visible=Document('A',1,{'p1':'Recepción provisional, con observaciones pendientes.'},
                     {'read':frozenset({'bruno'}),'share':frozenset({'bruno'}),'receive':frozenset({'ana'})})
    hidden=Document('A',1,{'p2':'Contenido excluido para Ana.'},
                    {'read':frozenset({'bruno'}),'share':frozenset({'bruno'}),'receive':frozenset({'admin'})})
    other=replace(visible,space='B')
    policy=Policy(members,frozenset({'ana','bruno','admin'}),grants,{'d1':visible,'d2':hidden,'d3':other},authorities={'A':'bruno'})
    request=Request('r1','A','ana',frozenset({'ana','bruno'}),900)
    draft=Draft(request,'bruno',(('d1',1),),(('d1','p1'),),1,1)
    return policy,draft


class AccessTests(unittest.TestCase):
    def test_literal_quote_and_no_generated_reason(self):
        p,d=fixture(); data=json.loads(materialize(p,d,100))
        self.assertEqual(data['evidence'][0]['quote'],p.documents['d1'].spans['p1'])
        self.assertNotIn('reason',data['evidence'][0])

    def test_all_256_combinations_of_authorization_requirements(self):
        # Independent oracle: one successful configuration; disabling any precondition denies.
        for bits in product((False,True),repeat=8):
            member,identity,search,receive,read,share,document_access,unexpired=bits
            p,d=fixture()
            grants=set(p.grants)
            for enabled,triple in [(search,('ana','A','search')),(receive,('ana','A','receive')),
                                   (read,('bruno','A','read')),(share,('bruno','A','share'))]:
                if not enabled: grants.discard(triple)
            docs=dict(p.documents)
            if not document_access: docs['d1']=replace(docs['d1'],audiences={})
            p=replace(p,grants=frozenset(grants),documents=docs,
                      members=p.members if member else p.members-{('ana','A')},
                      verified=p.verified if identity else p.verified-{'ana'},expires=1000 if unexpired else 100)
            with self.subTest(bits=bits):
                if all(bits): self.assertTrue(materialize(p,d,100))
                else:
                    with self.assertRaises(Denied): materialize(p,d,100)

    def test_manage_does_not_imply_content_permission(self):
        p,d=fixture()
        self.assertTrue(p.can('admin','manage','A',100))
        for action in ('read','share','receive','search'):
            self.assertFalse(p.can('admin',action,'A',100,'d1'))

    def test_manage_cannot_grant_itself_read_or_replace_policy_authority(self):
        p,d=fixture()
        self.assertFalse(p.may_change_content_grants('admin','A',100,1))
        self.assertTrue(p.may_change_content_grants('bruno','A',100,1))
        self.assertFalse(p.may_change_content_grants('bruno','B',100,1))
        self.assertFalse(p.may_change_content_grants('bruno','A',100,2))
        self.assertFalse(p.may_change_content_grants('bruno','A',1000,1))

    def test_exposure_restrictions_apply_even_to_uncited_source(self):
        p,d=fixture()
        with self.assertRaises(Denied): materialize(p,replace(d,exposure=(('d1',1),('d2',1))),100)

    def test_document_grant_does_not_cross_space_boundary(self):
        p,d=fixture()
        with self.assertRaises(Denied): materialize(p,replace(d,exposure=(('d3',1),),selections=(('d3','p1'),)),100)

    def test_missing_query_authorization(self):
        p,d=fixture()
        with self.assertRaises(Denied): materialize(p,replace(d,request=replace(d.request,query_audience=frozenset({'ana'}))),100)

    def test_stale_versions_and_expiry(self):
        p,d=fixture()
        variants=[(replace(p,epoch=2),d,100),(replace(p,corpus_revision=2),d,100),
                  (p,replace(d,exposure=(('d1',2),)),100),(p,d,900),(p,d,1000)]
        for policy,draft,now in variants:
            with self.subTest(policy=policy.epoch,now=now,draft=draft.exposure):
                with self.assertRaises(Denied): materialize(policy,draft,now)

    def test_forged_and_duplicate_evidence(self):
        p,d=fixture()
        for selections in [(('d1','unknown'),),(('d2','p2'),),(('d1','p1'),('d1','p1')),()]:
            with self.subTest(selections=selections):
                with self.assertRaises(Denied): materialize(p,replace(d,selections=selections),100)


class TransactionTests(unittest.TestCase):
    def test_no_dispatch_without_local_approval(self):
        p,d=fixture(); box=Outbox(); self.addCleanup(box.close); box.stage('r1')
        with self.assertRaises(Denied): box.dispatch(p,d,100)

    def test_injected_failure_rolls_back_approval_and_outbox(self):
        p,d=fixture(); box=Outbox(); self.addCleanup(box.close); box.stage('r1')
        with self.assertRaises(RuntimeError): box.approve(p,d,100,1,True)
        self.assertEqual(box.db.execute('SELECT count(*) FROM approval').fetchone()[0],0)
        self.assertEqual(box.db.execute('SELECT count(*) FROM outbox').fetchone()[0],0)
        self.assertEqual(box.db.execute('SELECT state FROM review').fetchone()[0],'REVIEW')

    def test_restart_keeps_exact_bytes_and_deduplicates_retry(self):
        p,d=fixture()
        with tempfile.TemporaryDirectory() as folder:
            file=Path(folder)/'outbox.db'
            box=Outbox(file); box.stage('r1'); approved=box.approve(p,d,100,1); box.close()
            box=Outbox(file)
            try:
                first=box.dispatch(p,d,101); second=box.dispatch(p,d,102)
                self.assertEqual(approved,first); self.assertEqual(first,second)
                inbox=Inbox()
                self.assertEqual(inbox.receive('B','B','A','A','resp1',first),'stored')
                self.assertEqual(inbox.receive('B','B','A','A','resp1',second),'duplicate')
            finally: box.close()

    def test_revision_conflicts_and_double_approval(self):
        p,d=fixture(); box=Outbox(); self.addCleanup(box.close); box.stage('r1',2)
        with self.assertRaises(Denied): box.approve(p,d,100,1)
        box.approve(p,replace(d,revision=2),100,2)
        with self.assertRaises(Denied): box.approve(p,replace(d,revision=2),100,2)

    def test_revocation_before_dispatch_and_after_first_dispatch(self):
        p,d=fixture(); box=Outbox(); self.addCleanup(box.close); box.stage('r1'); box.approve(p,d,100,1)
        revoked=replace(p,epoch=2,grants=p.grants-{('ana','A','receive')})
        with self.assertRaises(Denied): box.dispatch(revoked,d,101)
        inflight=box.dispatch(p,d,101)
        with self.assertRaises(Denied): box.dispatch(revoked,d,102)
        self.assertTrue(inflight)  # Revocation cannot recall a previously authorized attempt.

    def test_payload_tampering_is_not_sent(self):
        p,d=fixture(); box=Outbox(); self.addCleanup(box.close); box.stage('r1'); box.approve(p,d,100,1)
        with box.db: box.db.execute('UPDATE approval SET payload=?',(b'changed',))
        with self.assertRaises(Denied): box.dispatch(p,d,101)

    def test_inbox_rejects_wrong_peer_space_and_id_collision(self):
        inbox=Inbox()
        for peer,space in [('C','A'),('B','B')]:
            with self.assertRaises(Denied): inbox.receive(peer,'B',space,'A','resp1',b'one')
        self.assertEqual(inbox.receive('B','B','A','A','resp1',b'one'),'stored')
        with self.assertRaises(Denied): inbox.receive('B','B','A','A','resp1',b'two')


if __name__=='__main__': unittest.main(verbosity=2)
