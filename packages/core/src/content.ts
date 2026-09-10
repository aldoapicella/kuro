import { CORE_LIMITS, KuroError, digestBytes, referenceKey } from '@kuro/contracts';
import type { IdSource, Passage, PassageReference, ReviewView } from '@kuro/contracts';
import type { SpanRow } from './rows.js';

export function splitText(bytes: Uint8Array, ids: IdSource, available: number): { spans: {id:string;start:number;end:number;text:string;fingerprint:string}[]; partial:boolean } {
  if (!bytes.length || bytes.length > CORE_LIMITS.maxImportBytes) throw new KuroError('INVALID_INPUT');
  let text: string;
  try { text = new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes); } catch { throw new KuroError('INVALID_INPUT'); }
  if (text.includes('\0')) throw new KuroError('INVALID_INPUT');
  const spans: {id:string;start:number;end:number;text:string;fingerprint:string}[] = [];
  let start = 0;
  while (start < bytes.length && spans.length < available) {
    let end = Math.min(start+CORE_LIMITS.maxBlockBytes,bytes.length);
    while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
    // Prefer paragraph boundaries while preserving every original byte, including CRLF.
    if (end < bytes.length) for (let i=end-1;i>start+CORE_LIMITS.maxBlockBytes/2;i--) {
      if (bytes[i]===10 && bytes[i-1]===10) { end=i+1; break; }
    }
    const block=bytes.slice(start,end);
    spans.push({id:ids.nextId(),start,end,text:new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(block),fingerprint:digestBytes(block)});
    start=end;
  }
  return {spans,partial:start<bytes.length};
}
export function passageFromRow(row: SpanRow, originKey: string): Passage {
  return {ref:{originKey,documentId:row.document_id,versionId:row.version_id,spanId:row.span_id,startByte:row.start_byte,endByte:row.end_byte},text:row.text};
}
export function selectedPassages(view: ReviewView): Passage[] {
  const selected=new Set(view.selectedSpanIds);
  return view.passages.filter(p=>selected.has(p.ref.spanId));
}
export function sameReferences(a: PassageReference[], b: PassageReference[]): boolean {
  return a.length===b.length && a.every((ref,i)=>referenceKey(ref)===referenceKey(b[i]!));
}
