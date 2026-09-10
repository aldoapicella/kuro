export interface DocumentRow { space_id:string; document_id:string; version_id:string; revision:number; ingestion_state:'PENDING'|'COMPLETE'|'PARTIAL'|'FAILED' }
export interface SpanRow { space_id:string; document_id:string; version_id:string; span_id:string; start_byte:number; end_byte:number; text:string; fingerprint:string }
export interface GenerationRow { space_id:string; generation:number; profile_json:string; corpus_revision:number; state:string }
export interface RequestRow {
 request_id:string; direction:'IN'|'OUT'; space_id:string; peer_key:string; member_id:string; space_alias:string;
 bytes:Uint8Array; digest:string; query:string; state:string; admitted_wall:number; expires_wall:number; expires_mono:number;
 policy_epoch:number; corpus_revision:number; index_generation:number; job_id:string|null; next_attempt:number; attempts:number; response_id:string|null;
}
export interface JobRow {
 sequence:number; job_id:string; space_id:string; identity_id:string; kind:'INDEX'|'SEARCH'|'SUMMARY'; payload:string;
 state:string; policy_epoch:number; corpus_revision:number; index_generation:number; deadline_wall:number|null; deadline_mono:number|null; computation_ms:number; error_code:string|null;
}
export interface ReviewRow { draft_id:string; request_id:string; space_id:string; revision:number; state:string; view_json:string }
export interface ApprovalRow {
 response_id:string; draft_id:string; request_id:string; space_id:string; peer_key:string; reviewer_id:string;
 view_digest:string; bytes:Uint8Array; digest:string; dependencies:string; policy_epoch:number; corpus_revision:number;
 index_generation:number; expires_wall:number; expires_mono:number;
}
export interface OutboxRow { response_id:string; state:string; attempts:number; next_attempt:number }
export interface InboxRow {
 peer_key:string; response_id:string; request_id:string; space_id:string; space_alias:string; bytes:Uint8Array; digest:string;
 first_receipt_wall:number; expires_wall:number; expires_mono:number; received_process:string;
}
export interface SummaryRow { summary_id:string; job_id:string; response_id:string; space_id:string; state:string; preparation_json:string|null; result_json:string|null; policy_epoch:number; expires_wall:number; error_code:string|null }
