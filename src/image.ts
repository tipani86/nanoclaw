import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

/**
 * Stub image processor — saves the raw image to the group's attachments dir
 * and returns a content string referencing it.
 *
 * The full implementation (with sharp resizing and multimodal content blocks)
 * is provided by the add-image-vision skill.
 */
export async function processImage(
  buf: Buffer,
  groupDir: string,
  caption: string,
): Promise<{ content: string; relativePath: string } | null> {
  try {
    const attachDir = path.join(groupDir, 'attachments');
    fs.mkdirSync(attachDir, { recursive: true });

    const hash = crypto.createHash('md5').update(buf).digest('hex').slice(0, 8);
    const fileName = `image-${hash}.jpg`;
    const filePath = path.join(attachDir, fileName);
    fs.writeFileSync(filePath, buf);

    const relativePath = path.relative(groupDir, filePath);
    const content = caption
      ? `[Image: ${caption}] saved to ${relativePath}`
      : `[Image] saved to ${relativePath}`;

    return { content, relativePath };
  } catch {
    return null;
  }
}
