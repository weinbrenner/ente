import type { EnteFile } from "../types/file";

/**
 * Index Exif in the given file.
 *
 * This function is invoked as part of the ML indexing pipeline, which is why it
 * uses the same "index" nomenclature. But what it does is more of an extraction
 * / backfill process. The idea is that since we are anyways retrieving the
 * original file to index it for faces and CLIP, we might as well extract the
 * Exif and store it as part of the derived data (so that future features can
 * more readily use it), and also backfill any fields that old clients might've
 * not extracted during their file uploads.
 *
 * @param enteFile The {@link EnteFile} which we're indexing.
 *
 * @param
 *
 * [Note: Exif not EXIF]
 *
 * The standard uses "Exif" (not "EXIF") to refer to itself. We do the same.
 *
 * [Note: Indexing Exif]
 *
 * We don't really index Exif, we
 */
export const indexExif = (enteFile: EnteFile) => {
    return {
        title: enteFile.title ?? "",
    };
};
