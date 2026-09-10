import { constants, lstatSync, realpathSync } from 'node:fs';
import { open, realpath, lstat } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { randomBytes, randomInt } from 'node:crypto';
import { KuroError } from '@kuro/contracts';
import type { Clock, IdSource, SelectedFilePort, SelectedText } from '@kuro/contracts';

export const systemClock: Clock = { wallNowMs:()=>Date.now(),monotonicNowMs:()=>Math.floor(performance.now()) };
export const secureIds: IdSource = { nextId:()=>randomBytes(16).toString('hex'),randomUnit:()=>randomInt(0,0x100000000)/0x100000000 };

/** Host registers paths from a trusted file-picker; the renderer receives opaque tokens. */
export class SelectedTextFiles implements SelectedFilePort {
  #selections = new Map<string,{path:string;device:number;inode:number}>();
  register(selectedPath: string): string {
    const path=resolve(selectedPath);
    if(realpathSync(path)!==path)throw new KuroError('INVALID_INPUT');
    const stat=lstatSync(path);
    if(!stat.isFile()||stat.isSymbolicLink())throw new KuroError('INVALID_INPUT');
    const id=secureIds.nextId();this.#selections.set(id,{path,device:stat.dev,inode:stat.ino});return id;
  }
  async read(selectionId: string,maxBytes: number): Promise<SelectedText> {
    const selection=this.#selections.get(selectionId); this.#selections.delete(selectionId);
    if(!selection)throw new KuroError('INVALID_INPUT');const {path}=selection;
    if (extname(path).toLowerCase()!=='.txt') throw new KuroError('INVALID_INPUT');
    // Reject links in all path components, not only the final selected name.
    if ((await realpath(path))!==path || (await lstat(path)).isSymbolicLink()) throw new KuroError('INVALID_INPUT');
    const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
    try {
      const before=await file.stat();
      if (!before.isFile() || before.dev!==selection.device || before.ino!==selection.inode || before.size<=0 || before.size>maxBytes) throw new KuroError('INVALID_INPUT');
      const bytes=new Uint8Array(before.size);
      let offset=0;
      while(offset<bytes.length) {
        const part=await file.read(bytes,offset,bytes.length-offset,offset);
        if (!part.bytesRead) throw new KuroError('INVALID_INPUT');
        offset+=part.bytesRead;
      }
      const after=await file.stat();
      if (before.size!==after.size || before.mtimeMs!==after.mtimeMs || before.ctimeMs!==after.ctimeMs || before.ino!==after.ino) throw new KuroError('STALE_REVISION');
      return {bytes,mediaType:'text/plain',localPath:path};
    } finally { await file.close(); }
  }
}
