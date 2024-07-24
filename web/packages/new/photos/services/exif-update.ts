import { lowercaseExtension } from "@/base/file";
import log from "@/base/log";
import { FILE_TYPE } from "@/media/file-type";
import piexif from "piexifjs";
import type { EnteFile } from "../types/file";

/**
 * Return a new stream after applying Exif updates if applicable to the given
 * stream, otherwise return the original.
 *
 * This function is meant to provide a stream that can be used to download (or
 * export) a file to the user's computer after applying any Exif updates to the
 * original file's data.
 *
 * -   This only updates JPEG files.
 *
 * -   For JPEG files, the DateTimeOriginal Exif entry is updated to reflect the
 *     time that the user edited within Ente.
 *
 * @param enteFile The {@link EnteFile} whose data we want.
 *
 * @param stream A {@link ReadableStream} containing the original data for
 * {@link enteFile}.
 *
 * @returns A new {@link ReadableStream} with updates if any updates were
 * needed, otherwise return the original stream.
 */
export const updateExifIfNeededAndPossible = async (
    enteFile: EnteFile,
    stream: ReadableStream<Uint8Array>,
): Promise<ReadableStream<Uint8Array>> => {
    // Not needed: Not an image.
    if (enteFile.metadata.fileType != FILE_TYPE.IMAGE) return stream;

    // Not needed: Time was not edited.
    // TODO: Until the types reflect reality
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (!enteFile.pubMagicMetadata?.data.editedTime) return stream;

    const fileName = enteFile.metadata.title;
    const extension = lowercaseExtension(fileName);
    // Not possible: Not a JPEG (likely).
    if (extension != "jpeg" && extension != "jpg") return stream;

    const blob = await new Response(stream).blob();
    try {
        const updatedBlob = await setJPEGExifDateTimeOriginal(
            blob,
            new Date(enteFile.pubMagicMetadata.data.editedTime / 1000),
        );
        return updatedBlob.stream();
    } catch (e) {
        log.error(`Failed to modify Exif date for ${fileName}`, e);
        // We used the file's extension to determine if this was a JPEG, but
        // this is not a guarantee. Misnamed files, while rare, do exist. So if
        // that is the error thrown by the underlying library, fallback to the
        // original instead of causing the entire download or export to fail.
        if (
            e instanceof Error &&
            e.message.endsWith("Given file is neither JPEG nor TIFF.")
        ) {
            return blob.stream();
        }
        throw e;
    }
};

/**
 * Return a new blob with the "DateTimeOriginal" Exif tag set to the given
 * {@link date}.
 *
 * @param jpegBlob A {@link Blob} containing JPEG data.
 *
 * @param date A {@link Date} to use as the value for the Exif
 * "DateTimeOriginal" tag.
 *
 * @returns A new blob derived from {@link jpegBlob} but with the updated date.
 */
const setJPEGExifDateTimeOriginal = async (jpegBlob: Blob, date: Date) => {
    let dataURL = await blobToDataURL(jpegBlob);
    // Since we pass a Blob without an associated type, we get back a generic
    // data URL of the form "data:application/octet-stream;base64,...".
    //
    // Modify it to have a `image/jpeg` MIME type.
    dataURL = "data:image/jpeg;base64" + dataURL.slice(dataURL.indexOf(","));

    const exifObj = piexif.load(dataURL);
    if (!exifObj.Exif) exifObj.Exif = {};
    exifObj.Exif[piexif.ExifIFD.DateTimeOriginal] =
        convertToExifDateFormat(date);
    const exifBytes = piexif.dump(exifObj);
    const exifInsertedFile = piexif.insert(exifBytes, dataURL);

    return dataURLToBlob(exifInsertedFile);
};

/**
 * Convert a blob to a `data:` URL.
 */
const blobToDataURL = (blob: Blob) =>
    new Promise<string>((resolve) => {
        const reader = new FileReader();
        // We need to cast to a string here. This should be safe since MDN says:
        //
        // > the result attribute contains the data as a data: URL representing
        // > the file's data as a base64 encoded string.
        // >
        // > https://developer.mozilla.org/en-US/docs/Web/API/FileReader/readAsDataURL
        reader.onload = () => resolve(reader.result as string);
        reader.readAsDataURL(blob);
    });

/**
 * Convert a `data:` URL to a blob.
 *
 * Requires `connect-src data:` in the CSP (since it internally uses `fetch` to
 * perform the conversion).
 */
const dataURLToBlob = (dataURI: string) =>
    fetch(dataURI).then((res) => res.blob());

/**
 * Convert the given {@link Date} to a format that is expected by Exif for the
 * DateTimeOriginal tag.
 *
 * [Note: Exif dates]
 *
 * Summary:
 *
 * DateTimeOriginal is in local time, not UTC. Which local time? The
 * OffsetTimeOriginal specifies the time zone. But support for it is limited.
 *
 * Details:
 *
 * Common Exif date time tags, an in particular "DateTimeOriginal", are
 * specified in the form:
 *
 *     yyyy:MM:DD HH:mm:ss
 *
 * These values thus do not have an associated UTC offset or TZ.
 *
 * The common convention is that these times are interpreted to be the local
 * time where the photo was taken.
 *
 * > The reason (I assume) for this omission is because (prior to smartphones),
 * > cameras did not have a good way of being aware of their time zone.
 *
 * Recently, there seems to be increasing support for the newly standardized
 * "OffsetTimeOriginal" and siblings, which specify time zone for
 * "DateTimeOriginal" (and related fields).
 *
 * However, support is still not universal, and there will anyways be older
 * photos. So when the offset is missing, we stick with the common convention:
 *
 * -   When reading, assume that the Exif date is in the local TZ when deriving
 *     a UTC timestamp from it.
 *
 * -   When writing, convert the UTC timestamp to local time.
 *
 * These assumptions are fallible, because the local time where we're uploading
 * or downloading the photo is not necessarily the same as the local time where
 * the photo was taken.
 */
const convertToExifDateFormat = (date: Date) => {
    // TODO: Exif - Handle offsettime if present
    const yyyy = date.getFullYear();
    const MM = zeroPad(date.getMonth() + 1, 2);
    const dd = zeroPad(date.getDate(), 2);
    const HH = zeroPad(date.getHours(), 2);
    const mm = zeroPad(date.getMinutes(), 2);
    const ss = zeroPad(date.getSeconds(), 2);

    return `${yyyy}:${MM}:${dd} ${HH}:${mm}:${ss}`;
};

/** Zero pad the given number to {@link d} digits. */
const zeroPad = (n: number, d: number) => n.toString().padStart(d, "0");