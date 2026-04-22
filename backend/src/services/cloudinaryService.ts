import { v2 as cloudinary } from 'cloudinary';

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

export function uploadImage(fileBuffer: Buffer, folder: string, filename: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder, public_id: filename, resource_type: 'image' },
      (error, result) => {
        if (error) {
          reject(error);
          return;
        }
        if (!result?.secure_url) {
          reject(new Error('Cloudinary upload did not return a secure URL'));
          return;
        }
        resolve(result.secure_url);
      },
    );
    stream.end(fileBuffer);
  });
}

export async function deleteImage(publicId: string): Promise<void> {
  await cloudinary.uploader.destroy(publicId);
}

export function getPublicIdFromUrl(url: string): string {
  const uploadMarker = '/upload/';
  const markerIndex = url.indexOf(uploadMarker);
  if (markerIndex === -1) {
    throw new Error('Invalid Cloudinary URL: missing upload marker');
  }

  const pathAfterUpload = url.slice(markerIndex + uploadMarker.length);
  const segments = pathAfterUpload.split('/').filter(Boolean);
  if (segments.length === 0) {
    throw new Error('Invalid Cloudinary URL: missing path segments');
  }

  const versionSegmentIndex = segments.findIndex((segment) => /^v\d+$/.test(segment));
  const publicIdSegments =
    versionSegmentIndex >= 0 ? segments.slice(versionSegmentIndex + 1) : segments;
  if (publicIdSegments.length === 0) {
    throw new Error('Invalid Cloudinary URL: missing public ID');
  }

  const last = publicIdSegments[publicIdSegments.length - 1]!;
  publicIdSegments[publicIdSegments.length - 1] = last.replace(/\.[^/.]+$/, '');

  return publicIdSegments.join('/');
}
