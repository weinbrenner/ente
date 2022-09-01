import React, { useContext, useEffect, useRef, useState } from 'react';

import { syncCollections, createAlbum } from 'services/collectionService';
import constants from 'utils/strings/constants';
import UploadProgress from './UploadProgress';

import UploadStrategyChoiceModal from './UploadStrategyChoiceModal';
import { SetCollectionNamerAttributes } from '../Collections/CollectionNamer';
import { SetCollectionSelectorAttributes } from 'types/gallery';
import { GalleryContext } from 'pages/gallery';
import { AppContext } from 'pages/_app';
import { logError } from 'utils/sentry';
import UploadManager from 'services/upload/uploadManager';
import uploadManager from 'services/upload/uploadManager';
import ImportService from 'services/importService';
import isElectron from 'is-electron';
import { CustomError } from 'utils/error';
import { Collection } from 'types/collection';
import { SetLoading, SetFiles } from 'types/gallery';
import {
    ImportSuggestion,
    ElectronFile,
    FileWithCollection,
} from 'types/upload';
import Router from 'next/router';
import { isCanvasBlocked } from 'utils/upload/isCanvasBlocked';
import { downloadApp } from 'utils/common';
import DiscFullIcon from '@mui/icons-material/DiscFull';
import { NotificationAttributes } from 'types/Notification';
import {
    UploadFileNames,
    UploadCounter,
    SegregatedFinishedUploads,
    InProgressUpload,
} from 'types/upload/ui';
import {
    DEFAULT_IMPORT_SUGGESTION,
    UPLOAD_STAGES,
    UPLOAD_STRATEGY,
    UPLOAD_TYPE,
} from 'constants/upload';
import importService from 'services/importService';
import { getDownloadAppMessage } from 'utils/ui';
import UploadTypeSelector from './UploadTypeSelector';
import {
    getImportSuggestion,
    groupFilesBasedOnParentFolder,
} from 'utils/upload';

const FIRST_ALBUM_NAME = 'My First Album';

interface Props {
    syncWithRemote: (force?: boolean, silent?: boolean) => Promise<void>;
    closeCollectionSelector: () => void;
    closeUploadTypeSelector: () => void;
    setCollectionSelectorAttributes: SetCollectionSelectorAttributes;
    setCollectionNamerAttributes: SetCollectionNamerAttributes;
    setLoading: SetLoading;
    uploadInProgress: boolean;
    setUploadInProgress: (value: boolean) => void;
    showCollectionSelector: () => void;
    setFiles: SetFiles;
    isFirstUpload: boolean;
    uploadTypeSelectorView: boolean;
    showSessionExpiredMessage: () => void;
    showUploadFilesDialog: () => void;
    showUploadDirsDialog: () => void;
    folderSelectorFiles: File[];
    fileSelectorFiles: File[];
    dragAndDropFiles: File[];
}

export default function Uploader(props: Props) {
    const [uploadProgressView, setUploadProgressView] = useState(false);
    const [uploadStage, setUploadStage] = useState<UPLOAD_STAGES>();
    const [uploadFileNames, setUploadFileNames] = useState<UploadFileNames>();
    const [uploadCounter, setUploadCounter] = useState<UploadCounter>({
        finished: 0,
        total: 0,
    });
    const [inProgressUploads, setInProgressUploads] = useState<
        InProgressUpload[]
    >([]);
    const [finishedUploads, setFinishedUploads] =
        useState<SegregatedFinishedUploads>(new Map());
    const [percentComplete, setPercentComplete] = useState(0);
    const [hasLivePhotos, setHasLivePhotos] = useState(false);

    const [choiceModalView, setChoiceModalView] = useState(false);
    const [importSuggestion, setImportSuggestion] = useState<ImportSuggestion>(
        DEFAULT_IMPORT_SUGGESTION
    );
    const appContext = useContext(AppContext);
    const galleryContext = useContext(GalleryContext);

    const toUploadFiles = useRef<File[] | ElectronFile[]>(null);
    const isPendingDesktopUpload = useRef(false);
    const pendingDesktopUploadCollectionName = useRef<string>('');
    const uploadType = useRef<UPLOAD_TYPE>(null);
    const zipPaths = useRef<string[]>(null);
    const [electronFiles, setElectronFiles] = useState<ElectronFile[]>(null);
    const [webFiles, setWebFiles] = useState([]);

    const closeUploadProgress = () => setUploadProgressView(false);

    useEffect(() => {
        UploadManager.init(
            {
                setPercentComplete,
                setUploadCounter,
                setInProgressUploads,
                setFinishedUploads,
                setUploadStage,
                setUploadFilenames: setUploadFileNames,
                setHasLivePhotos,
            },
            props.setFiles
        );

        if (isElectron() && ImportService.checkAllElectronAPIsExists()) {
            ImportService.getPendingUploads().then(
                ({ files: electronFiles, collectionName, type }) => {
                    resumeDesktopUpload(type, electronFiles, collectionName);
                }
            );
        }
    }, []);

    useEffect(() => {
        if (
            uploadType.current === UPLOAD_TYPE.FOLDERS &&
            props.folderSelectorFiles?.length > 0
        ) {
            setWebFiles(props.folderSelectorFiles);
        } else if (
            uploadType.current === UPLOAD_TYPE.FILES &&
            props.fileSelectorFiles?.length > 0
        ) {
            setWebFiles(props.fileSelectorFiles);
        } else if (props.dragAndDropFiles?.length > 0) {
            setWebFiles(props.dragAndDropFiles);
        }
    }, [
        props.dragAndDropFiles,
        props.fileSelectorFiles,
        props.folderSelectorFiles,
    ]);

    useEffect(() => {
        if (
            electronFiles?.length > 0 ||
            webFiles?.length > 0 ||
            appContext.sharedFiles?.length > 0
        ) {
            if (props.uploadInProgress) {
                // no-op
                // a upload is already in progress
                return;
            }
            if (isCanvasBlocked()) {
                appContext.setDialogMessage({
                    title: constants.CANVAS_BLOCKED_TITLE,

                    content: constants.CANVAS_BLOCKED_MESSAGE(),
                    close: { text: constants.CLOSE },
                    proceed: {
                        text: constants.DOWNLOAD,
                        action: downloadApp,
                        variant: 'accent',
                    },
                });
                return;
            }
            props.setLoading(true);
            if (webFiles?.length > 0) {
                // File selection by drag and drop or selection of file.
                toUploadFiles.current = webFiles;
                setWebFiles([]);
            } else if (appContext.sharedFiles?.length > 0) {
                toUploadFiles.current = appContext.sharedFiles;
                appContext.resetSharedFiles();
            } else if (electronFiles?.length > 0) {
                // File selection from desktop app
                toUploadFiles.current = electronFiles;
                setElectronFiles([]);
            }
            const importSuggestion = getImportSuggestion(
                uploadType.current,
                toUploadFiles.current
            );
            setImportSuggestion(importSuggestion);

            handleCollectionCreationAndUpload(
                importSuggestion,
                props.isFirstUpload
            );
            props.setLoading(false);
        }
    }, [webFiles, appContext.sharedFiles, electronFiles]);

    const resumeDesktopUpload = async (
        type: UPLOAD_TYPE,
        electronFiles: ElectronFile[],
        collectionName: string
    ) => {
        if (electronFiles && electronFiles?.length > 0) {
            isPendingDesktopUpload.current = true;
            pendingDesktopUploadCollectionName.current = collectionName;
            uploadType.current = type;
            setElectronFiles(electronFiles);
        }
    };

    const uploadFilesToExistingCollection = async (collection: Collection) => {
        try {
            await preUploadAction();
            const filesWithCollectionToUpload: FileWithCollection[] =
                toUploadFiles.current.map((file, index) => ({
                    file,
                    localID: index,
                    collectionID: collection.id,
                }));
            await uploadFiles(filesWithCollectionToUpload, [collection]);
        } catch (e) {
            logError(e, 'Failed to upload files to existing collections');
        }
    };

    const uploadFilesToNewCollections = async (
        strategy: UPLOAD_STRATEGY,
        collectionName?: string
    ) => {
        try {
            await preUploadAction();
            const filesWithCollectionToUpload: FileWithCollection[] = [];
            const collections: Collection[] = [];
            let collectionNameToFilesMap = new Map<
                string,
                (File | ElectronFile)[]
            >();
            if (strategy === UPLOAD_STRATEGY.SINGLE_COLLECTION) {
                collectionNameToFilesMap.set(
                    collectionName,
                    toUploadFiles.current
                );
            } else {
                collectionNameToFilesMap = groupFilesBasedOnParentFolder(
                    toUploadFiles.current
                );
            }
            try {
                const existingCollection = await syncCollections();
                let index = 0;
                for (const [
                    collectionName,
                    files,
                ] of collectionNameToFilesMap) {
                    const collection = await createAlbum(
                        collectionName,
                        existingCollection
                    );
                    collections.push(collection);

                    filesWithCollectionToUpload.push(
                        ...files.map((file) => ({
                            localID: index++,
                            collectionID: collection.id,
                            file,
                        }))
                    );
                }
            } catch (e) {
                closeUploadProgress();
                logError(e, 'Failed to create album');
                appContext.setDialogMessage({
                    title: constants.ERROR,

                    close: { variant: 'danger' },
                    content: constants.CREATE_ALBUM_FAILED,
                });
                throw e;
            }
            await uploadFiles(filesWithCollectionToUpload, collections);
        } catch (e) {
            logError(e, 'Failed to upload files to new collections');
        }
    };

    const preUploadAction = async () => {
        props.closeCollectionSelector();
        props.closeUploadTypeSelector();
        uploadManager.prepareForNewUpload();
        setUploadProgressView(true);
        props.setUploadInProgress(true);
        await props.syncWithRemote(true, true);
    };

    function postUploadAction() {
        props.setUploadInProgress(false);
        props.syncWithRemote();
    }

    const uploadFiles = async (
        filesWithCollectionToUploadIn: FileWithCollection[],
        collections: Collection[]
    ) => {
        try {
            if (isElectron() && !isPendingDesktopUpload.current) {
                await ImportService.setToUploadCollection(collections);
                if (zipPaths.current) {
                    await ImportService.setToUploadFiles(
                        UPLOAD_TYPE.ZIPS,
                        zipPaths.current
                    );
                    zipPaths.current = null;
                }
                await ImportService.setToUploadFiles(
                    UPLOAD_TYPE.FILES,
                    filesWithCollectionToUploadIn.map(
                        ({ file }) => (file as ElectronFile).path
                    )
                );
            }
            await uploadManager.queueFilesForUpload(
                filesWithCollectionToUploadIn,
                collections
            );
        } catch (err) {
            showUserFacingError(err.message);
            closeUploadProgress();
            throw err;
        } finally {
            postUploadAction();
        }
    };

    const retryFailed = async () => {
        try {
            await preUploadAction();
            await uploadManager.retryFailedFiles();
        } catch (err) {
            showUserFacingError(err.message);
            closeUploadProgress();
        } finally {
            postUploadAction();
        }
    };

    function showUserFacingError(err: CustomError) {
        let notification: NotificationAttributes;
        switch (err) {
            case CustomError.SESSION_EXPIRED:
                return props.showSessionExpiredMessage();
            case CustomError.SUBSCRIPTION_EXPIRED:
                notification = {
                    variant: 'danger',
                    message: constants.SUBSCRIPTION_EXPIRED,
                    action: {
                        text: constants.UPGRADE_NOW,
                        callback: galleryContext.showPlanSelectorModal,
                    },
                };
                break;
            case CustomError.STORAGE_QUOTA_EXCEEDED:
                notification = {
                    variant: 'danger',
                    message: constants.STORAGE_QUOTA_EXCEEDED,
                    action: {
                        text: constants.RENEW_NOW,
                        callback: galleryContext.showPlanSelectorModal,
                    },
                    icon: <DiscFullIcon fontSize="large" />,
                };
                break;
            default:
                notification = {
                    variant: 'danger',
                    message: constants.UNKNOWN_ERROR,
                };
        }
        galleryContext.setNotificationAttributes(notification);
    }

    const uploadToSingleNewCollection = (collectionName: string) => {
        if (collectionName) {
            uploadFilesToNewCollections(
                UPLOAD_STRATEGY.SINGLE_COLLECTION,
                collectionName
            );
        } else {
            showCollectionCreateModal();
        }
    };
    const showCollectionCreateModal = () => {
        props.setCollectionNamerAttributes({
            title: constants.CREATE_COLLECTION,
            buttonText: constants.CREATE,
            autoFilledName: null,
            callback: uploadToSingleNewCollection,
        });
    };

    const handleCollectionCreationAndUpload = (
        importSuggestion: ImportSuggestion,
        isFirstUpload: boolean
    ) => {
        if (isPendingDesktopUpload.current) {
            isPendingDesktopUpload.current = false;
            if (pendingDesktopUploadCollectionName.current) {
                uploadToSingleNewCollection(
                    pendingDesktopUploadCollectionName.current
                );
                pendingDesktopUploadCollectionName.current = null;
            } else {
                uploadFilesToNewCollections(
                    UPLOAD_STRATEGY.COLLECTION_PER_FOLDER
                );
            }
            return;
        }
        if (isElectron() && uploadType.current === UPLOAD_TYPE.ZIPS) {
            uploadFilesToNewCollections(UPLOAD_STRATEGY.COLLECTION_PER_FOLDER);
            return;
        }
        if (isFirstUpload && !importSuggestion.rootFolderName) {
            importSuggestion.rootFolderName = FIRST_ALBUM_NAME;
        }
        let showNextModal = () => {};
        if (importSuggestion.hasNestedFolders) {
            showNextModal = () => setChoiceModalView(true);
        } else {
            showNextModal = () =>
                uploadToSingleNewCollection(importSuggestion.rootFolderName);
        }
        props.setCollectionSelectorAttributes({
            callback: uploadFilesToExistingCollection,
            showNextModal,
            title: constants.UPLOAD_TO_COLLECTION,
        });
    };
    const handleDesktopUpload = async (type: UPLOAD_TYPE) => {
        let files: ElectronFile[];
        uploadType.current = type;
        if (type === UPLOAD_TYPE.FILES) {
            files = await ImportService.showUploadFilesDialog();
        } else if (type === UPLOAD_TYPE.FOLDERS) {
            files = await ImportService.showUploadDirsDialog();
        } else {
            const response = await ImportService.showUploadZipDialog();
            files = response.files;
            zipPaths.current = response.zipPaths;
        }
        if (files?.length > 0) {
            setElectronFiles(files);
            props.closeUploadTypeSelector();
        }
    };

    const handleWebUpload = async (type: UPLOAD_TYPE) => {
        uploadType.current = type;
        if (type === UPLOAD_TYPE.FILES) {
            props.showUploadFilesDialog();
        } else if (type === UPLOAD_TYPE.FOLDERS) {
            props.showUploadDirsDialog();
        } else {
            appContext.setDialogMessage(getDownloadAppMessage());
        }
    };

    const cancelUploads = async () => {
        closeUploadProgress();
        if (isElectron()) {
            ImportService.cancelRemainingUploads();
        }
        props.setUploadInProgress(false);
        Router.reload();
    };

    const handleUpload = (type) => () => {
        if (isElectron() && importService.checkAllElectronAPIsExists()) {
            handleDesktopUpload(type);
        } else {
            handleWebUpload(type);
        }
    };

    const handleFileUpload = handleUpload(UPLOAD_TYPE.FILES);
    const handleFolderUpload = handleUpload(UPLOAD_TYPE.FOLDERS);
    const handleZipUpload = handleUpload(UPLOAD_TYPE.ZIPS);

    return (
        <>
            <UploadStrategyChoiceModal
                open={choiceModalView}
                onClose={() => setChoiceModalView(false)}
                uploadToSingleCollection={() =>
                    uploadToSingleNewCollection(importSuggestion.rootFolderName)
                }
                uploadToMultipleCollection={() =>
                    uploadFilesToNewCollections(
                        UPLOAD_STRATEGY.COLLECTION_PER_FOLDER
                    )
                }
            />
            <UploadTypeSelector
                show={props.uploadTypeSelectorView}
                onHide={props.closeUploadTypeSelector}
                uploadFiles={handleFileUpload}
                uploadFolders={handleFolderUpload}
                uploadGoogleTakeoutZips={handleZipUpload}
            />
            <UploadProgress
                open={uploadProgressView}
                onClose={closeUploadProgress}
                percentComplete={percentComplete}
                uploadFileNames={uploadFileNames}
                uploadCounter={uploadCounter}
                uploadStage={uploadStage}
                inProgressUploads={inProgressUploads}
                hasLivePhotos={hasLivePhotos}
                retryFailed={retryFailed}
                finishedUploads={finishedUploads}
                cancelUploads={cancelUploads}
            />
        </>
    );
}
