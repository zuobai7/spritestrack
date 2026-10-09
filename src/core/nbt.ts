/**
 * Reader for Minecraft's NBT format (big-endian named binary tags), as used by
 * .schem and .schematic files. Byte arrays come back as Uint8Array, int and
 * long arrays as Int32Array and BigInt64Array, lists as arrays, compounds as
 * plain objects.
 */

export type NbtValue = number | bigint | string | Uint8Array | Int32Array | BigInt64Array | NbtValue[] | NbtCompound;
export interface NbtCompound {
  [key: string]: NbtValue;
}

export function isCompound(v: NbtValue | undefined): v is NbtCompound {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && !ArrayBuffer.isView(v);
}

const utf8 = new TextDecoder();

/** Parses an uncompressed NBT document; the root must be a compound. */
export function readNbt(buf: Uint8Array): { name: string; value: NbtCompound } {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let p = 0;
  const length = () => {
    const n = dv.getInt32(p);
    p += 4;
    if (n < 0 || n > buf.length) throw new Error('Invalid NBT length');
    return n;
  };
  const str = () => {
    const n = dv.getUint16(p);
    p += 2;
    if (p + n > buf.length) throw new Error('Truncated NBT');
    const s = utf8.decode(buf.subarray(p, p + n));
    p += n;
    return s;
  };
  const payload = (type: number, depth: number): NbtValue => {
    if (depth > 512) throw new Error('NBT nested too deeply');
    switch (type) {
      case 1:
        return dv.getInt8(p++);
      case 2: {
        const v = dv.getInt16(p);
        p += 2;
        return v;
      }
      case 3: {
        const v = dv.getInt32(p);
        p += 4;
        return v;
      }
      case 4: {
        const v = dv.getBigInt64(p);
        p += 8;
        return v;
      }
      case 5: {
        const v = dv.getFloat32(p);
        p += 4;
        return v;
      }
      case 6: {
        const v = dv.getFloat64(p);
        p += 8;
        return v;
      }
      case 7: {
        const n = length();
        if (p + n > buf.length) throw new Error('Truncated NBT');
        const v = buf.slice(p, p + n);
        p += n;
        return v;
      }
      case 8:
        return str();
      case 9: {
        const t = dv.getUint8(p++);
        const n = length();
        const out: NbtValue[] = [];
        for (let i = 0; i < n; i++) out.push(payload(t, depth + 1));
        return out;
      }
      case 10: {
        const out: NbtCompound = {};
        for (;;) {
          const t = dv.getUint8(p++);
          if (t === 0) break;
          const name = str();
          out[name] = payload(t, depth + 1);
        }
        return out;
      }
      case 11: {
        const n = length();
        const out = new Int32Array(n);
        for (let i = 0; i < n; i++, p += 4) out[i] = dv.getInt32(p);
        return out;
      }
      case 12: {
        const n = length();
        const out = new BigInt64Array(n);
        for (let i = 0; i < n; i++, p += 8) out[i] = dv.getBigInt64(p);
        return out;
      }
      default:
        throw new Error(`Unknown NBT tag ${type}`);
    }
  };
  if (buf.length < 3 || dv.getUint8(0) !== 10) throw new Error('Not an NBT file');
  p = 1;
  const name = str();
  return { name, value: payload(10, 0) as NbtCompound };
}

/** Undoes gzip compression when the data has the gzip signature; other data is returned as is. */
export async function gunzipIfNeeded(data: Uint8Array): Promise<Uint8Array> {
  if (data.length < 2 || data[0] !== 0x1f || data[1] !== 0x8b) return data;
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
