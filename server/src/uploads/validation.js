import path from 'node:path';

const DOCUMENTS = {
  pdf: { mime: 'application/pdf', signature: buffer => buffer.subarray(0, 5).toString('ascii') === '%PDF-' },
  jpg: { mime: 'image/jpeg', signature: buffer => buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff },
  jpeg: { mime: 'image/jpeg', signature: buffer => buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff },
  png: { mime: 'image/png', signature: buffer => buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) },
};

const IMAGE_TYPES = {
  jpg: DOCUMENTS.jpg,
  jpeg: DOCUMENTS.jpeg,
  png: DOCUMENTS.png,
};

export function safeUploadName(name) {
  return path.basename(String(name || 'upload')).replace(/[\r\n\0]/g, '').slice(0, 200) || 'upload';
}

export function detectDocumentMime(file) {
  if (!Buffer.isBuffer(file?.buffer) || file.buffer.length === 0) return null;
  const extension = path.extname(file.originalname || '').slice(1).toLowerCase();
  const entry = DOCUMENTS[extension];
  if (!entry || !entry.signature(file.buffer) || file.mimetype !== entry.mime) return null;
  if (extension === 'pdf' && !file.buffer.subarray(Math.max(0, file.buffer.length - 2048)).includes(Buffer.from('%%EOF'))) return null;
  return entry.mime;
}

export function detectImageMime(file) {
  if (!Buffer.isBuffer(file?.buffer) || file.buffer.length === 0) return null;
  const extension = path.extname(file.originalname || '').slice(1).toLowerCase();
  const entry = IMAGE_TYPES[extension];
  return entry && entry.signature(file.buffer) && file.mimetype === entry.mime ? entry.mime : null;
}
