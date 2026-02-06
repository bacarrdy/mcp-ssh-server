import type { Client, SFTPWrapper } from "ssh2";

export interface ConnectionEntry {
  client: Client;
  host: string;
  port: number;
  username: string;
  connectedAt: Date;
  lastUsedAt: Date;
  sftp?: SFTPWrapper;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface SftpEntry {
  name: string;
  type: "file" | "directory" | "symlink" | "other";
  size: number;
  modifyTime: string;
  accessTime: string;
  owner: number;
  group: number;
  permissions: string;
}

export interface SftpStat {
  size: number;
  modifyTime: string;
  accessTime: string;
  owner: number;
  group: number;
  permissions: string;
  isDirectory: boolean;
  isFile: boolean;
  isSymlink: boolean;
}

export interface KeyPairResult {
  publicKey: string;
  privateKey: string;
  type: string;
  bits?: number;
  comment?: string;
}

export interface ForwardInfo {
  id: string;
  type: "local" | "remote";
  bindAddr: string;
  bindPort: number;
  destAddr: string;
  destPort: number;
  connectionId: string;
}
