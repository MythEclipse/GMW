import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// Mock node-crc to provide pure JS implementation and bypass native build issues
const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let r = i << 24;
  for (let j = 0; j < 8; j++) {
    r = (r & 0x80000000) !== 0 ? (r << 1) ^ 0x04c11db7 : r << 1;
  }
  CRC_TABLE[i] = r >>> 0;
}

const Module = require("node:module");
const originalRequire = Module.prototype.require;
Module.prototype.require = function (id: string) {
  if (id === "node-crc") {
    return {
      crc: function (
        width: number,
        reflectIn: boolean,
        poly: number,
        init: number,
        refOut: boolean,
        xorOut: number,
        unk1: number,
        unk2: number,
        buffer: Buffer,
      ) {
        let crc = 0;
        for (let i = 0; i < buffer.length; i++) {
          crc =
            ((crc << 8) >>> 0) ^ CRC_TABLE[((crc >>> 24) ^ buffer[i]) & 0xff];
          crc >>>= 0;
        }
        const result = Buffer.alloc(4);
        result.writeUInt32BE(crc, 0);
        return result;
      },
    };
  }
  return originalRequire.apply(this, arguments);
};

console.log("[mock] node-crc has been mocked globally for ESM.");

export {};
