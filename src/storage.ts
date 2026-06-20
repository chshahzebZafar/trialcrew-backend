/**
 * Day-0 proof storage (Cloudflare R2, S3-compatible). Gated by R2 env vars — inert
 * (returns `configured: false`) until they're set, so the server runs without R2.
 * The AWS S3 SDK is lazy-imported only when R2 is configured.
 *
 * Flow: client → POST /cycles/:id/proof/upload-url → { uploadUrl, key, publicUrl } →
 * client PUTs the image bytes to uploadUrl → POST /cycles/:id/proof { screenshotUrl: publicUrl }.
 */
import { config, r2Enabled } from "./config.js";

export interface ProofUploadTarget {
  configured: boolean;
  uploadUrl: string; // short-lived signed PUT url ("" when not configured)
  key: string;
  publicUrl: string; // final object url ("" when not configured)
}

export async function createProofUploadUrl(
  cycleId: string,
  contentType: string,
): Promise<ProofUploadTarget> {
  const ext = contentType.includes("png") ? "png" : "jpg";
  const key = `proofs/${cycleId}/${Date.now()}.${ext}`;

  if (!r2Enabled) return { configured: false, uploadUrl: "", key, publicUrl: "" };

  const { S3Client, PutObjectCommand } = await import("@aws-sdk/client-s3");
  const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");

  const s3 = new S3Client({
    region: "auto",
    endpoint: `https://${config.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: config.R2_ACCESS_KEY_ID!,
      secretAccessKey: config.R2_SECRET_ACCESS_KEY!,
    },
  });

  const uploadUrl = await getSignedUrl(
    s3,
    new PutObjectCommand({ Bucket: config.R2_BUCKET!, Key: key, ContentType: contentType }),
    { expiresIn: 300 },
  );
  const base = (config.R2_PUBLIC_URL ?? "").replace(/\/$/, "");
  return { configured: true, uploadUrl, key, publicUrl: `${base}/${key}` };
}
