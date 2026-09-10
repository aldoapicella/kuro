declare module 'hyperdht' {
  import { EventEmitter } from 'node:events';
  export interface KeyPair { publicKey: Uint8Array; secretKey: Uint8Array }
  export interface BootstrapNode { host: string; port: number }
  export interface Socket extends EventEmitter {
    readonly remotePublicKey: Uint8Array;
    readonly destroyed: boolean;
    readonly connected: boolean;
    readonly handshakeHash: Uint8Array | null;
    readonly isInitiator: boolean;
    write(bytes: Uint8Array): boolean;
    flush(): Promise<boolean>;
    destroy(error?: Error): void;
  }
  export interface ConnectionPool extends EventEmitter {
    get(remotePublicKey: Uint8Array): Socket | null;
  }
  export interface Server { listen(keyPair?: KeyPair): Promise<Server>; close(): Promise<void> }
  export interface DhtOptions { bootstrap?: readonly BootstrapNode[]; keyPair?: KeyPair; port?: number; ephemeral?: boolean; host?: string; firewalled?: boolean }
  export default class HyperDHT extends EventEmitter {
    constructor(options?: DhtOptions);
    static keyPair(seed?: Uint8Array): KeyPair;
    static bootstrapper(port: number, host: string): HyperDHT;
    createServer(options: { firewall: (remotePublicKey: Uint8Array) => boolean; pool?: ConnectionPool }, listener?: (socket: Socket) => void): Server;
    connect(remotePublicKey: Uint8Array, options?: { pool?: ConnectionPool }): Socket;
    pool(): ConnectionPool;
    fullyBootstrapped(): Promise<void>;
    address(): { host: string; port: number };
    destroy(): Promise<void>;
  }
}
