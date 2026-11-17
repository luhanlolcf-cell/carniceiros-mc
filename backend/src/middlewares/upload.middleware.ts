import { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs/promises';

const ALLOWED_MIME_TYPES: Record<string, string[]> = {
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/png': ['.png'],
  'image/webp': ['.webp'],
  'application/pdf': ['.pdf'],
};

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

/**
 * Inspeciona os Magic Bytes (assinatura binária real do cabeçalho do arquivo)
 * para impedir ataques de spoofing de extensão (ex: shell.php renomeado para flyer.jpg).
 */
function detectMagicBytes(buf: Buffer): { mime: string; ext: string } | null {
  if (buf.length < 12) return null;

  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { mime: 'image/jpeg', ext: 'jpg' };
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return { mime: 'image/png', ext: 'png' };
  }
  // WEBP: "RIFF" .... "WEBP"
  if (
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return { mime: 'image/webp', ext: 'webp' };
  }
  // PDF: "%PDF-" (25 50 44 46 2D)
  if (buf.toString('ascii', 0, 5) === '%PDF-') {
    return { mime: 'application/pdf', ext: 'pdf' };
  }

  return null;
}

// Armazenamento em memória inicial para inspeção de Magic Bytes antes de persistir no S3 / disco seguro
export const uploadBuffer = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_FILE_SIZE_BYTES,
    files: 1,
  },
});

/**
 * Valida os Magic Bytes reais do buffer (prevenindo spoofing de extensão como shell.php.jpg),
 * gera um nome criptografado aleatório (UUIDv4 + SHA-256) e salva fora da árvore pública de execução.
 */
export async function validateAndPersistUpload(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  if (!req.file) {
    next();
    return;
  }

  try {
    const detectedType = detectMagicBytes(req.file.buffer);

    if (!detectedType || !ALLOWED_MIME_TYPES[detectedType.mime]) {
      res.status(415).json({
        error: 'UNSUPPORTED_MEDIA_TYPE',
        message: 'Tipo de arquivo não permitido. Envie apenas imagens (JPG, PNG, WEBP) ou documentos PDF.',
      });
      return;
    }

    const originalExt = path.extname(req.file.originalname).toLowerCase();
    if (!ALLOWED_MIME_TYPES[detectedType.mime].includes(originalExt)) {
      res.status(400).json({
        error: 'EXTENSION_MISMATCH',
        message: 'A extensão do arquivo não corresponde à assinatura binária real do conteúdo.',
      });
      return;
    }

    // Cálculo de hash SHA-256 de integridade + nome seguro não adivinhável
    const sha256Checksum = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
    const safeFileName = `${crypto.randomUUID()}.${detectedType.ext}`;
    const safeStorageDir = path.resolve(process.cwd(), 'private_storage');

    await fs.mkdir(safeStorageDir, { recursive: true, mode: 0o700 });
    const destinationPath = path.join(safeStorageDir, safeFileName);
    await fs.writeFile(destinationPath, req.file.buffer, { mode: 0o600 });

    // Anexa metadados higienizados na requisição para o controller salvar no banco
    (req as any).validatedAttachment = {
      originalName: path.basename(req.file.originalname).replace(/[^\w.\- ]/g, '_'),
      storageKey: safeFileName,
      mimeType: detectedType.mime,
      sizeBytes: req.file.size,
      sha256Checksum,
    };

    next();
  } catch (error) {
    res.status(500).json({
      error: 'UPLOAD_VALIDATION_ERROR',
      message: 'Falha ao validar segurança do arquivo enviado.',
    });
  }
}
