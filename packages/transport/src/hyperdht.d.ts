declare module 'hyperdht' {
  import { EventEmitter } from 'node:events';
  export interface KeyPair { publicKey: Uint8Array; secretKey: Uint8Array }
  export interface BootstrapNode { host: string; port: number }
  export interface Socket extends EventEmitter {
    readonly remotePublicKey: Uint8Array;
    readonly destroyed: boolean;
    write(bytes: Uint8Array): boolean;
    destroy(error?: Error): void;
  }
  export interface Server { listen(keyPair?: KeyPair): Promise<Server>; close(): Promise<void> }
  export interface DhtOptions { bootstrap?: readonly BootstrapNode[]; keyPair?: KeyPair; ephemeral?: boolean; host?: string; firewalled?: boolean }
  export default class HyperDHT extends EventEmitter {
    constructor(options?: DhtOptions);
    static keyPair(seed?: Uint8Array): KeyPair;
    static bootstrapper(port: number, host: string): HyperDHT;
    createServer(options: { firewall: (remotePublicKey: Uint8Array) => boolean }, listener: (socket: Socket) => void): Server;
    connect(remotePublicKey: Uint8Array): Socket;
    fullyBootstrapped(): Promise<void>;
    address(): { host: string; port: number };
    destroy(): Promise<void>;
  }
}
