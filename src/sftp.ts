import type { SFTPWrapper, FileEntryWithStats } from "ssh2";
import type { ConnectionEntry, SftpEntry, SftpStat } from "./types.js";

const MAX_FILE_SIZE = parseInt(
  process.env.SSH_MCP_MAX_FILE_SIZE || "1048576",
  10
);

async function getSftp(entry: ConnectionEntry): Promise<SFTPWrapper> {
  if (entry.sftp) return entry.sftp;

  return new Promise((resolve, reject) => {
    entry.client.sftp((err, sftp) => {
      if (err) {
        reject(new Error(`SFTP session failed: ${err.message}`));
        return;
      }
      entry.sftp = sftp;
      sftp.on("end", () => {
        entry.sftp = undefined;
      });
      resolve(sftp);
    });
  });
}

function formatPermissions(mode: number): string {
  const types: Record<number, string> = {
    0o040000: "d",
    0o120000: "l",
    0o100000: "-",
  };
  const type = types[mode & 0o170000] || "?";
  const perms = [
    mode & 0o400 ? "r" : "-",
    mode & 0o200 ? "w" : "-",
    mode & 0o100 ? "x" : "-",
    mode & 0o040 ? "r" : "-",
    mode & 0o020 ? "w" : "-",
    mode & 0o010 ? "x" : "-",
    mode & 0o004 ? "r" : "-",
    mode & 0o002 ? "w" : "-",
    mode & 0o001 ? "x" : "-",
  ].join("");
  return type + perms;
}

function fileType(
  entry: FileEntryWithStats
): "file" | "directory" | "symlink" | "other" {
  const attrs = entry.attrs;
  if (attrs.isDirectory()) return "directory";
  if (attrs.isSymbolicLink()) return "symlink";
  if (attrs.isFile()) return "file";
  return "other";
}

export async function ls(
  entry: ConnectionEntry,
  path: string
): Promise<SftpEntry[]> {
  const sftp = await getSftp(entry);

  return new Promise((resolve, reject) => {
    sftp.readdir(path, (err, list) => {
      if (err) {
        reject(new Error(`SFTP readdir failed: ${err.message}`));
        return;
      }
      const entries: SftpEntry[] = list.map((f) => ({
        name: f.filename,
        type: fileType(f),
        size: f.attrs.size,
        modifyTime: new Date(f.attrs.mtime * 1000).toISOString(),
        accessTime: new Date(f.attrs.atime * 1000).toISOString(),
        owner: f.attrs.uid,
        group: f.attrs.gid,
        permissions: formatPermissions(f.attrs.mode),
      }));
      // Sort: directories first, then alphabetical
      entries.sort((a, b) => {
        if (a.type === "directory" && b.type !== "directory") return -1;
        if (a.type !== "directory" && b.type === "directory") return 1;
        return a.name.localeCompare(b.name);
      });
      resolve(entries);
    });
  });
}

export async function read(
  entry: ConnectionEntry,
  path: string,
  encoding?: "utf8" | "base64",
  maxSize?: number
): Promise<{ content: string; encoding: string; size: number }> {
  const sftp = await getSftp(entry);
  const limit = maxSize ?? MAX_FILE_SIZE;

  // Check file size first
  const stats = await new Promise<{ size: number }>((resolve, reject) => {
    sftp.stat(path, (err, attrs) => {
      if (err) {
        reject(new Error(`SFTP stat failed: ${err.message}`));
        return;
      }
      resolve({ size: attrs.size });
    });
  });

  if (stats.size > limit) {
    throw new Error(
      `File is ${stats.size} bytes, exceeds max ${limit} bytes. ` +
        `Set maxSize parameter or SSH_MCP_MAX_FILE_SIZE env var to increase.`
    );
  }

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const stream = sftp.createReadStream(path);

    stream.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });

    stream.on("end", () => {
      const buffer = Buffer.concat(chunks);
      const enc = encoding ?? "utf8";
      resolve({
        content: buffer.toString(enc),
        encoding: enc,
        size: buffer.length,
      });
    });

    stream.on("error", (err: Error) => {
      reject(new Error(`SFTP read failed: ${err.message}`));
    });
  });
}

export async function write(
  entry: ConnectionEntry,
  path: string,
  content: string,
  encoding?: "utf8" | "base64",
  mode?: number
): Promise<{ path: string; size: number }> {
  const sftp = await getSftp(entry);
  const enc = encoding ?? "utf8";
  const buffer = Buffer.from(content, enc as BufferEncoding);

  return new Promise((resolve, reject) => {
    const opts: Record<string, unknown> = {};
    if (mode !== undefined) opts.mode = mode;

    const stream = sftp.createWriteStream(path, opts);

    stream.on("close", () => {
      resolve({ path, size: buffer.length });
    });

    stream.on("error", (err: Error) => {
      reject(new Error(`SFTP write failed: ${err.message}`));
    });

    stream.end(buffer);
  });
}

export async function mkdir(
  entry: ConnectionEntry,
  path: string,
  recursive?: boolean
): Promise<void> {
  const sftp = await getSftp(entry);

  if (recursive) {
    // Build up path segments and create each
    const parts = path.split("/").filter(Boolean);
    let current = path.startsWith("/") ? "/" : "";
    for (const part of parts) {
      current = current ? `${current}/${part}`.replace("//", "/") : part;
      try {
        await new Promise<void>((resolve, reject) => {
          sftp.mkdir(current, (err) => {
            if (err && (err as unknown as { code: number }).code !== 4) {
              // SFTP status code 4 = SSH_FX_FAILURE (already exists)
              reject(new Error(`SFTP mkdir failed: ${err.message}`));
            } else {
              resolve();
            }
          });
        });
      } catch (e) {
        // Check if it already exists as directory
        try {
          await new Promise<void>((resolve, reject) => {
            sftp.stat(current, (err, attrs) => {
              if (err) reject(e);
              else if (attrs.isDirectory()) resolve();
              else reject(new Error(`${current} exists but is not a directory`));
            });
          });
        } catch {
          throw e;
        }
      }
    }
  } else {
    await new Promise<void>((resolve, reject) => {
      sftp.mkdir(path, (err) => {
        if (err) reject(new Error(`SFTP mkdir failed: ${err.message}`));
        else resolve();
      });
    });
  }
}

export async function rm(
  entry: ConnectionEntry,
  path: string,
  recursive?: boolean
): Promise<void> {
  const sftp = await getSftp(entry);

  // Check if it's a directory
  const isDir = await new Promise<boolean>((resolve, reject) => {
    sftp.stat(path, (err, attrs) => {
      if (err) reject(new Error(`SFTP stat failed: ${err.message}`));
      else resolve(attrs.isDirectory());
    });
  });

  if (isDir) {
    if (!recursive) {
      throw new Error(
        `"${path}" is a directory. Set recursive=true to remove it.`
      );
    }
    // Recursively delete contents
    const items = await ls(entry, path);
    for (const item of items) {
      await rm(entry, `${path}/${item.name}`, true);
    }
    await new Promise<void>((resolve, reject) => {
      sftp.rmdir(path, (err) => {
        if (err) reject(new Error(`SFTP rmdir failed: ${err.message}`));
        else resolve();
      });
    });
  } else {
    await new Promise<void>((resolve, reject) => {
      sftp.unlink(path, (err) => {
        if (err) reject(new Error(`SFTP unlink failed: ${err.message}`));
        else resolve();
      });
    });
  }
}

export async function mv(
  entry: ConnectionEntry,
  src: string,
  dest: string
): Promise<void> {
  const sftp = await getSftp(entry);

  await new Promise<void>((resolve, reject) => {
    sftp.rename(src, dest, (err) => {
      if (err) reject(new Error(`SFTP rename failed: ${err.message}`));
      else resolve();
    });
  });
}

export async function stat(
  entry: ConnectionEntry,
  path: string
): Promise<SftpStat> {
  const sftp = await getSftp(entry);

  return new Promise((resolve, reject) => {
    sftp.stat(path, (err, attrs) => {
      if (err) {
        reject(new Error(`SFTP stat failed: ${err.message}`));
        return;
      }
      resolve({
        size: attrs.size,
        modifyTime: new Date(attrs.mtime * 1000).toISOString(),
        accessTime: new Date(attrs.atime * 1000).toISOString(),
        owner: attrs.uid,
        group: attrs.gid,
        permissions: formatPermissions(attrs.mode),
        isDirectory: attrs.isDirectory(),
        isFile: attrs.isFile(),
        isSymlink: attrs.isSymbolicLink(),
      });
    });
  });
}
