document.addEventListener('DOMContentLoaded', () => {
    const { PDFDocument, rgb, degrees, StandardFonts, PDFName, PDFArray, PDFDict, PDFNumber } = PDFLib;
    const viewer = document.getElementById('pdf-viewer');
    const noPreviewMsg = document.getElementById('no-preview-msg');
    const statusMessage = document.getElementById('status-message');

    const modeMerge = document.getElementById('mode-merge');
    const modeSplit = document.getElementById('mode-split');
    const modeWatermark = document.getElementById('mode-watermark');

    const mergeSection = document.getElementById('merge-section');
    const splitSection = document.getElementById('split-section');
    const watermarkSection = document.getElementById('watermark-section');
    const wmInfo = document.getElementById('wm-info');
    const wmSettings = document.getElementById('wm-settings');
    const wmImageFields = document.getElementById('wm-image-fields');
    const wmTextFields = document.getElementById('wm-text-fields');

    const previewBtn = document.getElementById('preview-btn');
    const actionBtn = document.getElementById('action-btn');
    const clearBtn = document.getElementById('clear-btn');
    const outputPdfCheck = document.getElementById('output-pdf-check');
    const outputWebpCheck = document.getElementById('output-webp-check');
    const webpQualityWrap = document.getElementById('webp-quality-wrap');
    const webpQuality = document.getElementById('webp-quality');

    const wmImgInput = document.getElementById('wm-img-input');
    const wmType = document.getElementById('wm-type');
    const wmText = document.getElementById('wm-text');
    const wmFontSize = document.getElementById('wm-font-size');
    const wmTextColor = document.getElementById('wm-text-color');
    const wmScale = document.getElementById('wm-scale');
    const wmScaleVal = document.getElementById('wm-scale-val');
    const wmWidth = document.getElementById('wm-width');
    const wmHeight = document.getElementById('wm-height');
    const wmOpacity = document.getElementById('wm-opacity');
    const wmOpacityVal = document.getElementById('wm-opacity-val');
    const wmRotation = document.getElementById('wm-rotation');
    const wmRotationVal = document.getElementById('wm-rotation-val');
    const pageNumberPanel = document.getElementById('page-number-panel');
    const pageNumberCheck = document.getElementById('page-number-check');
    const pageNumberSettings = document.getElementById('page-number-settings');
    const pageNumberStyle = document.getElementById('page-number-style');
    const pageNumberSize = document.getElementById('page-number-size');
    const pageNumberStartPage = document.getElementById('page-number-start-page');
    const pageSizePanel = document.getElementById('page-size-panel');
    const pageSizeCheck = document.getElementById('page-size-check');
    const pageSizeSettings = document.getElementById('page-size-settings');
    const pageSizeDimension = document.getElementById('page-size-dimension');
    const pageSizeTargetInputs = Array.from(document.querySelectorAll('input[name="page-size-target"]'));
    const pageSizeOrientationWrap = document.getElementById('page-size-orientation-wrap');
    const pageSizeOrientation = document.getElementById('page-size-orientation');
    const pageSizeOtherWrap = document.getElementById('page-size-other-wrap');
    const pageSizeOtherPreset = document.getElementById('page-size-other-preset');
    const pageSizeCustomWrap = document.getElementById('page-size-custom-wrap');
    const pageSizeCustomWidth = document.getElementById('page-size-custom-width');
    const pageSizeCustomHeight = document.getElementById('page-size-custom-height');
    const spreadSplitPanel = document.getElementById('spread-split-panel');
    const spreadSplitCheck = document.getElementById('spread-split-check');
    const spreadSplitSettings = document.getElementById('spread-split-settings');
    const spreadSplitOrder = document.getElementById('spread-split-order');

    let selectedFiles = [];
    const filePageCounts = new WeakMap();
    const filePageLayouts = new WeakMap();
    let wmImgFile = null;
    let wmOriginalWidth = 0;
    let wmOriginalHeight = 0;
    let currentPreviewUrl = null;

    const getPrimaryFile = () => selectedFiles[0] || null;

    if (window.pdfjsLib) {
        pdfjsLib.GlobalWorkerOptions.workerSrc = '../../../vendor/pdf.worker.min.js';
    }

    const updateViewer = (url) => {
        if (currentPreviewUrl) {
            URL.revokeObjectURL(currentPreviewUrl);
        }

        currentPreviewUrl = url;
        viewer.removeAttribute('src');
        viewer.src = `${url}#toolbar=0&navpanes=0&scrollbar=1&view=FitH`;
        viewer.style.display = 'block';
        noPreviewMsg.style.display = 'none';
    };

    const resetViewer = () => {
        if (currentPreviewUrl) {
            URL.revokeObjectURL(currentPreviewUrl);
            currentPreviewUrl = null;
        }

        viewer.removeAttribute('src');
        viewer.style.display = 'none';
        noPreviewMsg.style.display = 'flex';
    };

    const setStatus = (message, isError = false) => {
        statusMessage.textContent = message;
        statusMessage.classList.toggle('error', isError);
    };

    const getOutputState = () => ({
        pdf: outputPdfCheck.checked,
        webp: outputWebpCheck.checked
    });

    const getWebpQualitySettings = () => {
        const presets = {
            small: { scale: 1, quality: 0.8 },
            standard: { scale: 2, quality: 0.9 },
            high: { scale: 3, quality: 0.95 }
        };

        return presets[webpQuality.value] || presets.standard;
    };

    const stripKnownExtension = (name) => name.replace(/\.(pdf|zip)$/i, '');

    const getSafeZipEntryName = (name) => stripKnownExtension(name)
        .replace(/[\\/:*?"<>|]/g, '_')
        .replace(/\s+/g, '_')
        .replace(/^_+|_+$/g, '') || 'pdf';

    const downloadBlob = (blob, filename, keepUrl = false) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();

        if (!keepUrl) {
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        }

        return url;
    };

    const getModeState = () => ({
        merge: modeMerge.checked,
        split: modeSplit.checked,
        watermark: modeWatermark.checked
    });

    const MM_TO_PT = 72 / 25.4;
    const PAPER_SIZES_MM = {
        A0: [841, 1189], A1: [594, 841], A2: [420, 594], A3: [297, 420],
        A4: [210, 297], A5: [148, 210], A6: [105, 148],
        B0: [1030, 1456], B1: [728, 1030], B2: [515, 728], B3: [364, 515],
        B4: [257, 364], B5: [182, 257], B6: [128, 182]
    };

    const getSelectedPageSizeTarget = () => {
        const selected = pageSizeTargetInputs.find((input) => input.checked);
        return selected ? selected.value : '';
    };

    const getPageSizeState = () => ({
        enabled: pageSizeCheck.checked,
        dimensionMode: pageSizeDimension.value === 'width' ? 'width' : 'page',
        target: getSelectedPageSizeTarget(),
        orientation: pageSizeOrientation.value === 'landscape' ? 'landscape' : 'portrait',
        otherPreset: pageSizeOtherPreset.value,
        customWidthMm: Number(pageSizeCustomWidth.value),
        customHeightMm: Number(pageSizeCustomHeight.value)
    });

    const getSpreadSplitState = () => ({
        enabled: spreadSplitCheck.checked,
        order: spreadSplitOrder.value === 'left-first' ? 'left-first' : 'right-first'
    });

    const normalizeRightAngleRotation = (angle) => {
        const normalized = ((angle % 360) + 360) % 360;
        return [0, 90, 180, 270].includes(normalized) ? normalized : 0;
    };

    const getVisiblePageLayout = (page) => {
        const cropBox = page.getCropBox();
        const rotation = normalizeRightAngleRotation(page.getRotation().angle);
        const swapsAxes = rotation === 90 || rotation === 270;
        const displayedWidth = swapsAxes ? cropBox.height : cropBox.width;
        const displayedHeight = swapsAxes ? cropBox.width : cropBox.height;

        return {
            cropBox: { ...cropBox },
            rotation,
            displayedWidth,
            displayedHeight,
            isLandscape: displayedWidth > displayedHeight
        };
    };

    const getPageSizeValidation = () => {
        const settings = getPageSizeState();
        if (!settings.enabled) {
            return { valid: true };
        }
        if (!settings.target) {
            return { valid: false, reason: 'ページサイズの基準を1つ選択してください。' };
        }
        if (settings.target === 'other' && settings.otherPreset === 'custom'
            && (!(settings.customWidthMm > 0) || !(settings.customHeightMm > 0))) {
            return { valid: false, reason: '任意用紙の幅と高さは正の数で指定してください。' };
        }
        return { valid: true };
    };

    const getDisplayedPageSize = (page) => {
        const { width, height } = page.getSize();
        const rotation = ((page.getRotation().angle % 360) + 360) % 360;
        return {
            rawWidth: width,
            rawHeight: height,
            rotation,
            width: rotation === 90 || rotation === 270 ? height : width,
            height: rotation === 90 || rotation === 270 ? width : height
        };
    };

    const resolvePageSizeTarget = (pageInfos, settings) => {
        if (settings.target === 'largest' || settings.target === 'smallest') {
            const comparer = settings.target === 'largest'
                ? (current, candidate) => candidate.width > current.width
                : (current, candidate) => candidate.width < current.width;
            const reference = pageInfos.reduce((current, candidate) => comparer(current, candidate) ? candidate : current);
            return { width: reference.width, height: reference.height };
        }

        const preset = settings.target === 'other' ? settings.otherPreset : settings.target;
        if (preset === 'custom') {
            return {
                width: settings.customWidthMm * MM_TO_PT,
                height: settings.customHeightMm * MM_TO_PT
            };
        }

        const [shortSide, longSide] = PAPER_SIZES_MM[preset];
        const portrait = settings.orientation === 'portrait';
        return {
            width: (portrait ? shortSide : longSide) * MM_TO_PT,
            height: (portrait ? longSide : shortSide) * MM_TO_PT
        };
    };

    const lookupArray = (context, dict, key) => {
        const value = dict.get(PDFName.of(key));
        if (!value) {
            return null;
        }
        try {
            const resolved = context.lookup(value);
            return resolved instanceof PDFArray ? resolved : null;
        } catch (error) {
            return null;
        }
    };

    const setArrayNumber = (array, index, value) => {
        const item = array.lookup(index, PDFNumber);
        if (item) {
            array.set(index, PDFNumber.of(value));
        }
    };

    const transformCoordinateArray = (array, scale, offsetX, offsetY) => {
        for (let index = 0; index + 1 < array.size(); index += 2) {
            const x = array.lookup(index, PDFNumber);
            const y = array.lookup(index + 1, PDFNumber);
            if (x && y) {
                setArrayNumber(array, index, (x.asNumber() * scale) + offsetX);
                setArrayNumber(array, index + 1, (y.asNumber() * scale) + offsetY);
            }
        }
    };

    const scaleDistanceArray = (array, scale) => {
        for (let index = 0; index < array.size(); index += 1) {
            const value = array.lookup(index, PDFNumber);
            if (value) {
                setArrayNumber(array, index, value.asNumber() * scale);
            }
        }
    };

    const transformAnnotationGeometry = (page, scale, offsetX, offsetY) => {
        const context = page.doc.context;
        const annotations = lookupArray(context, page.node, 'Annots');
        if (!annotations) {
            return;
        }

        for (let index = 0; index < annotations.size(); index += 1) {
            const annotation = context.lookup(annotations.get(index), PDFDict);
            if (!annotation) {
                continue;
            }

            const rect = lookupArray(context, annotation, 'Rect');
            if (rect) {
                transformCoordinateArray(rect, 1, offsetX, offsetY);
            }

            ['QuadPoints', 'Vertices', 'L', 'CL'].forEach((key) => {
                const coordinates = lookupArray(context, annotation, key);
                if (coordinates) {
                    transformCoordinateArray(coordinates, scale, offsetX, offsetY);
                }
            });

            const inkList = lookupArray(context, annotation, 'InkList');
            if (inkList) {
                for (let strokeIndex = 0; strokeIndex < inkList.size(); strokeIndex += 1) {
                    const stroke = context.lookup(inkList.get(strokeIndex), PDFArray);
                    if (stroke) {
                        transformCoordinateArray(stroke, scale, offsetX, offsetY);
                    }
                }
            }

            ['RD', 'Border'].forEach((key) => {
                const distances = lookupArray(context, annotation, key);
                if (distances) {
                    scaleDistanceArray(distances, scale);
                }
            });
        }
    };

    const getRectangleValues = (rectangle) => {
        if (!rectangle || rectangle.size() < 4) {
            return null;
        }

        try {
            const values = [0, 1, 2, 3].map((index) => rectangle.lookup(index, PDFNumber));
            if (values.some((value) => !value)) {
                return null;
            }
            return values.map((value) => value.asNumber());
        } catch (error) {
            return null;
        }
    };

    const clipAnnotationsToPage = (page, width, height) => {
        const context = page.doc.context;
        const annotations = lookupArray(context, page.node, 'Annots');
        if (!annotations) {
            return;
        }

        for (let index = annotations.size() - 1; index >= 0; index -= 1) {
            const annotation = context.lookup(annotations.get(index), PDFDict);
            const rectangle = annotation ? lookupArray(context, annotation, 'Rect') : null;
            const values = getRectangleValues(rectangle);
            if (!rectangle || !values) {
                continue;
            }

            const [x1, y1, x2, y2] = values;
            const clippedX1 = Math.max(0, Math.min(x1, x2));
            const clippedY1 = Math.max(0, Math.min(y1, y2));
            const clippedX2 = Math.min(width, Math.max(x1, x2));
            const clippedY2 = Math.min(height, Math.max(y1, y2));

            if (clippedX2 <= clippedX1 || clippedY2 <= clippedY1) {
                annotations.remove(index);
                continue;
            }

            setArrayNumber(rectangle, 0, clippedX1);
            setArrayNumber(rectangle, 1, clippedY1);
            setArrayNumber(rectangle, 2, clippedX2);
            setArrayNumber(rectangle, 3, clippedY2);
        }
    };

    const getVisualHalfRegions = (layout) => {
        const { cropBox, rotation } = layout;
        const lowerX = {
            x: cropBox.x,
            y: cropBox.y,
            width: cropBox.width / 2,
            height: cropBox.height
        };
        const upperX = {
            x: cropBox.x + (cropBox.width / 2),
            y: cropBox.y,
            width: cropBox.width / 2,
            height: cropBox.height
        };
        const lowerY = {
            x: cropBox.x,
            y: cropBox.y,
            width: cropBox.width,
            height: cropBox.height / 2
        };
        const upperY = {
            x: cropBox.x,
            y: cropBox.y + (cropBox.height / 2),
            width: cropBox.width,
            height: cropBox.height / 2
        };

        if (rotation === 90) {
            return { left: lowerY, right: upperY };
        }
        if (rotation === 180) {
            return { left: upperX, right: lowerX };
        }
        if (rotation === 270) {
            return { left: upperY, right: lowerY };
        }
        return { left: lowerX, right: upperX };
    };

    const configureSpreadHalfPage = (page, region) => {
        const offsetX = -region.x;
        const offsetY = -region.y;

        page.translateContent(offsetX, offsetY);
        page.resetPosition();
        transformAnnotationGeometry(page, 1, offsetX, offsetY);
        clipAnnotationsToPage(page, region.width, region.height);
        page.setMediaBox(0, 0, region.width, region.height);
        page.setCropBox(0, 0, region.width, region.height);
        page.setBleedBox(0, 0, region.width, region.height);
        page.setTrimBox(0, 0, region.width, region.height);
        page.setArtBox(0, 0, region.width, region.height);
    };

    const transformDestinationNumber = (destination, index, scale, offset) => {
        try {
            const value = destination.lookup(index, PDFNumber);
            if (value) {
                destination.set(index, PDFNumber.of((value.asNumber() * scale) + offset));
            }
        } catch (error) {
            // A null coordinate means the viewer should retain its current value.
        }
    };

    const transformDestination = (context, destination, pageTransforms) => {
        if (!destination || destination.size() < 2) {
            return;
        }
        const pageReference = destination.get(0);
        const transform = pageTransforms.get(pageReference.toString());
        const fitType = destination.lookup(1, PDFName);
        if (!transform || !fitType) {
            return;
        }

        const type = fitType.decodeText();
        if (type === 'XYZ') {
            transformDestinationNumber(destination, 2, transform.scale, transform.offsetX);
            transformDestinationNumber(destination, 3, transform.scale, transform.offsetY);
        } else if (type === 'FitH' || type === 'FitBH') {
            transformDestinationNumber(destination, 2, transform.scale, transform.offsetY);
        } else if (type === 'FitV' || type === 'FitBV') {
            transformDestinationNumber(destination, 2, transform.scale, transform.offsetX);
        } else if (type === 'FitR') {
            transformDestinationNumber(destination, 2, transform.scale, transform.offsetX);
            transformDestinationNumber(destination, 3, transform.scale, transform.offsetY);
            transformDestinationNumber(destination, 4, transform.scale, transform.offsetX);
            transformDestinationNumber(destination, 5, transform.scale, transform.offsetY);
        }
    };

    const transformInternalLinkDestinations = (pdfDoc, pageTransforms) => {
        const context = pdfDoc.context;
        pdfDoc.getPages().forEach((page) => {
            const annotations = lookupArray(context, page.node, 'Annots');
            if (!annotations) {
                return;
            }
            for (let index = 0; index < annotations.size(); index += 1) {
                const annotation = context.lookup(annotations.get(index), PDFDict);
                if (!annotation) {
                    continue;
                }
                const directDestination = lookupArray(context, annotation, 'Dest');
                if (directDestination) {
                    transformDestination(context, directDestination, pageTransforms);
                }
                const actionValue = annotation.get(PDFName.of('A'));
                const action = actionValue ? context.lookup(actionValue, PDFDict) : null;
                if (action) {
                    const actionDestination = lookupArray(context, action, 'D');
                    if (actionDestination) {
                        transformDestination(context, actionDestination, pageTransforms);
                    }
                }
            }
        });
    };

    const applySpreadSplitToBytes = async (sourceBytes) => {
        const settings = getSpreadSplitState();
        if (!settings.enabled) {
            return sourceBytes;
        }

        const sourceDoc = await PDFDocument.load(sourceBytes);
        const outputDoc = await PDFDocument.create();
        const sourcePages = sourceDoc.getPages();

        for (let index = 0; index < sourcePages.length; index += 1) {
            const layout = getVisiblePageLayout(sourcePages[index]);
            if (!layout.isLandscape) {
                const [copiedPage] = await outputDoc.copyPages(sourceDoc, [index]);
                outputDoc.addPage(copiedPage);
                continue;
            }

            const regions = getVisualHalfRegions(layout);
            const [leftPage] = await outputDoc.copyPages(sourceDoc, [index]);
            const [rightPage] = await outputDoc.copyPages(sourceDoc, [index]);
            configureSpreadHalfPage(leftPage, regions.left);
            configureSpreadHalfPage(rightPage, regions.right);

            const orderedPages = settings.order === 'left-first'
                ? [leftPage, rightPage]
                : [rightPage, leftPage];
            orderedPages.forEach((page) => outputDoc.addPage(page));
        }

        return outputDoc.save();
    };

    const applyPageSizeToBytes = async (sourceBytes) => {
        const settings = getPageSizeState();
        if (!settings.enabled) {
            return sourceBytes;
        }

        const validation = getPageSizeValidation();
        if (!validation.valid) {
            throw new Error(validation.reason);
        }

        const pdfDoc = await PDFDocument.load(sourceBytes);
        const pages = pdfDoc.getPages();
        if (pages.length === 0) {
            return pdfDoc.save();
        }

        const pageInfos = pages.map(getDisplayedPageSize);
        const target = resolvePageSizeTarget(pageInfos, settings);
        const pageTransforms = new Map();

        pages.forEach((page, index) => {
            const info = pageInfos[index];
            const scale = settings.dimensionMode === 'width'
                ? target.width / info.width
                : Math.min(target.width / info.width, target.height / info.height);

            page.scale(scale, scale);
            let offsetX = 0;
            let offsetY = 0;

            if (settings.dimensionMode === 'page') {
                const targetRawWidth = info.rotation === 90 || info.rotation === 270 ? target.height : target.width;
                const targetRawHeight = info.rotation === 90 || info.rotation === 270 ? target.width : target.height;
                const scaledRawWidth = info.rawWidth * scale;
                const scaledRawHeight = info.rawHeight * scale;
                offsetX = (targetRawWidth - scaledRawWidth) / 2;
                offsetY = (targetRawHeight - scaledRawHeight) / 2;
                page.setSize(targetRawWidth, targetRawHeight);
                page.translateContent(offsetX, offsetY);
            }

            transformAnnotationGeometry(page, scale, offsetX, offsetY);
            pageTransforms.set(page.ref.toString(), { scale, offsetX, offsetY });
        });

        transformInternalLinkDestinations(pdfDoc, pageTransforms);

        return pdfDoc.save();
    };

    const getWatermarkKind = () => (wmType.value === 'text' ? 'text' : 'image');
    const getPdfAlpha = () => 1 - (Number(wmOpacity.value) / 100);

    const addPageNumbers = async (pdfDoc, styleType, fontSize, startPage) => {
        const pages = pdfDoc.getPages();
        const startIndex = startPage - 1;
        const totalNumberedPages = pages.length - startIndex;
        const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

        pages.forEach((page, index) => {
            if (index < startIndex) {
                return;
            }

            const { width } = page.getSize();
            const pageNum = index - startIndex + 1;

            let text = '';
            if (styleType === 'dash') {
                text = `- ${pageNum} -`;
            } else if (styleType === 'bracket') {
                text = `< ${pageNum} >`;
            } else {
                text = `${pageNum} / ${totalNumberedPages}`;
            }

            const textWidth = font.widthOfTextAtSize(text, fontSize);
            page.drawText(text, {
                x: (width - textWidth) / 2,
                y: 20,
                size: fontSize,
                font,
                color: rgb(0.3, 0.3, 0.3)
            });
        });
    };

    const updatePrimaryFileState = async (showPreview = false) => {
        const primaryFile = getPrimaryFile();
        if (!primaryFile) {
            document.getElementById('sp-count').textContent = '';
            return;
        }

        let pageCount = filePageCounts.get(primaryFile);
        if (!pageCount) {
            const doc = await PDFDocument.load(await primaryFile.arrayBuffer());
            pageCount = doc.getPageCount();
            filePageCounts.set(primaryFile, pageCount);
            filePageLayouts.set(primaryFile, doc.getPages().map(getVisiblePageLayout));
        }
        document.getElementById('sp-count').textContent = pageCount;
        if (showPreview) {
            updateViewer(URL.createObjectURL(primaryFile));
        }
    };

    const renderList = () => {
        const listItems = document.getElementById('list-items');
        listItems.innerHTML = '';

        selectedFiles.forEach((file, index) => {
            const li = document.createElement('li');
            li.textContent = file.name;
            li.draggable = true;
            li.onclick = () => {
                document.querySelectorAll('#list-items li').forEach((el) => el.classList.remove('selected'));
                li.classList.add('selected');
                updateViewer(URL.createObjectURL(file));
            };
            li.ondragstart = (e) => e.dataTransfer.setData('text/plain', index);
            li.ondragover = (e) => e.preventDefault();
            li.ondrop = async (e) => {
                const from = Number(e.dataTransfer.getData('text/plain'));
                const moved = selectedFiles.splice(from, 1)[0];
                selectedFiles.splice(index, 0, moved);
                renderList();
                await updatePrimaryFileState(true);
                syncUiState();
            };
            listItems.appendChild(li);
        });

        document.getElementById('file-list').style.display = selectedFiles.length > 0 ? 'block' : 'none';
    };

    const getMergedBytes = async () => {
        const mergedDoc = await PDFDocument.create();
        for (const file of selectedFiles) {
            const doc = await PDFDocument.load(await file.arrayBuffer());
            const pages = await mergedDoc.copyPages(doc, doc.getPageIndices());
            pages.forEach((page) => mergedDoc.addPage(page));
        }

        return mergedDoc.save();
    };

    const getSplitIndices = (pageCount) => {
        const range = document.getElementById('split-range').value;
        const indices = [];

        range.split(',').forEach((part) => {
            const token = part.trim();
            if (!token) {
                return;
            }

            if (token.includes('-')) {
                const [start, end] = token.split('-').map(Number);
                for (let i = start; i <= end; i += 1) {
                    indices.push(i - 1);
                }
            } else {
                indices.push(Number(token) - 1);
            }
        });

        return indices.filter((index) => Number.isInteger(index) && index >= 0 && index < pageCount);
    };

    const getSplitBytes = async () => {
        const sourceFile = getPrimaryFile();
        const srcDoc = await PDFDocument.load(await sourceFile.arrayBuffer());
        const newDoc = await PDFDocument.create();
        const validIndices = getSplitIndices(srcDoc.getPageCount());
        const copied = await newDoc.copyPages(srcDoc, validIndices);
        copied.forEach((page) => newDoc.addPage(page));

        return newDoc.save();
    };

    const loadFileAsDataUrl = (file) => new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('ファイルの読み込みに失敗しました。'));
        reader.readAsDataURL(file);
    });

    const loadImageElement = (src) => new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error('画像の読み込みに失敗しました。'));
        image.src = src;
    });

    const dataUrlToArrayBuffer = async (dataUrl) => fetch(dataUrl).then((response) => response.arrayBuffer());

    const getCenteredDrawPosition = (centerX, centerY, width, height, angleDegrees) => {
        const radians = (angleDegrees * Math.PI) / 180;
        const cos = Math.cos(radians);
        const sin = Math.sin(radians);
        const offsetX = (width / 2) * cos - (height / 2) * sin;
        const offsetY = (width / 2) * sin + (height / 2) * cos;

        return {
            x: centerX - offsetX,
            y: centerY - offsetY
        };
    };

    const getRasterizedWatermark = async () => {
        if (!wmImgFile) {
            return null;
        }

        if (wmImgFile.type === 'image/svg+xml') {
            const dataUrl = await loadFileAsDataUrl(wmImgFile);
            const image = await loadImageElement(dataUrl);
            const canvas = document.createElement('canvas');
            canvas.width = image.naturalWidth || image.width;
            canvas.height = image.naturalHeight || image.height;
            const context = canvas.getContext('2d');

            if (!context) {
                throw new Error('SVG の変換に失敗しました。');
            }

            context.drawImage(image, 0, 0);
            return {
                bytes: await dataUrlToArrayBuffer(canvas.toDataURL('image/png')),
                format: 'png'
            };
        }

        return {
            bytes: await wmImgFile.arrayBuffer(),
            format: wmImgFile.type === 'image/jpeg' ? 'jpg' : 'png'
        };
    };

    const getTextWatermarkImage = async () => {
        const text = wmText.value.trim();
        const fontSize = Number(wmFontSize.value);
        const paddingX = Math.max(24, Math.ceil(fontSize * 0.6));
        const paddingY = Math.max(16, Math.ceil(fontSize * 0.4));
        const measureCanvas = document.createElement('canvas');
        const measureContext = measureCanvas.getContext('2d');

        if (!measureContext) {
            throw new Error('文字ウォーターマークの生成に失敗しました。');
        }

        measureContext.font = `${fontSize}px sans-serif`;
        const metrics = measureContext.measureText(text);
        const textWidth = Math.max(1, Math.ceil(metrics.width));
        const ascent = Math.ceil(metrics.actualBoundingBoxAscent || fontSize * 0.8);
        const descent = Math.ceil(metrics.actualBoundingBoxDescent || fontSize * 0.2);
        const canvas = document.createElement('canvas');
        canvas.width = textWidth + paddingX * 2;
        canvas.height = ascent + descent + paddingY * 2;
        const context = canvas.getContext('2d');

        if (!context) {
            throw new Error('文字ウォーターマークの生成に失敗しました。');
        }

        context.clearRect(0, 0, canvas.width, canvas.height);
        context.font = `${fontSize}px sans-serif`;
        context.textBaseline = 'alphabetic';
        context.textAlign = 'left';
        context.fillStyle = wmTextColor.value;
        context.fillText(text, paddingX, paddingY + ascent);

        return {
            bytes: await dataUrlToArrayBuffer(canvas.toDataURL('image/png')),
            width: canvas.width,
            height: canvas.height
        };
    };

    const drawImageWatermark = async (pdfDoc) => {
        const rasterized = await getRasterizedWatermark();
        if (!rasterized) {
            return;
        }

        const embedded = rasterized.format === 'jpg'
            ? await pdfDoc.embedJpg(rasterized.bytes)
            : await pdfDoc.embedPng(rasterized.bytes);

        const width = Number(wmWidth.value);
        const height = Number(wmHeight.value);
        const opacity = getPdfAlpha();
        const angleDegrees = Number(wmRotation.value);
        const rotation = degrees(angleDegrees);

        pdfDoc.getPages().forEach((page) => {
            const { width: pageWidth, height: pageHeight } = page.getSize();
            const position = getCenteredDrawPosition(pageWidth / 2, pageHeight / 2, width, height, angleDegrees);
            page.drawImage(embedded, {
                x: position.x,
                y: position.y,
                width,
                height,
                opacity,
                rotate: rotation
            });
        });
    };

    const drawTextWatermark = async (pdfDoc) => {
        const textImage = await getTextWatermarkImage();
        const embedded = await pdfDoc.embedPng(textImage.bytes);
        const opacity = getPdfAlpha();
        const angleDegrees = Number(wmRotation.value);
        const rotation = degrees(angleDegrees);

        pdfDoc.getPages().forEach((page) => {
            const { width: pageWidth, height: pageHeight } = page.getSize();
            const position = getCenteredDrawPosition(
                pageWidth / 2,
                pageHeight / 2,
                textImage.width,
                textImage.height,
                angleDegrees
            );
            page.drawImage(embedded, {
                x: position.x,
                y: position.y,
                width: textImage.width,
                height: textImage.height,
                opacity,
                rotate: rotation
            });
        });
    };

    const applyWatermarkToBytes = async (sourceBytes) => {
        const pdfDoc = await PDFDocument.load(sourceBytes);

        if (getWatermarkKind() === 'text') {
            await drawTextWatermark(pdfDoc);
        } else {
            await drawImageWatermark(pdfDoc);
        }

        return pdfDoc.save();
    };

    const applyPageNumbersToBytes = async (sourceBytes) => {
        if (!pageNumberCheck.checked) {
            return sourceBytes;
        }

        const pdfDoc = await PDFDocument.load(sourceBytes);
        const startPage = Number(pageNumberStartPage.value);
        if (!Number.isInteger(startPage) || startPage < 1 || startPage > pdfDoc.getPageCount()) {
            throw new Error(`番号を付け始めるページは1〜${pdfDoc.getPageCount()}の整数で指定してください。`);
        }

        await addPageNumbers(pdfDoc, pageNumberStyle.value, Number(pageNumberSize.value), startPage);
        return pdfDoc.save();
    };

    const getBaseOutputPageLayouts = (mode) => {
        const primaryFile = getPrimaryFile();
        if (mode.split && primaryFile) {
            const layouts = filePageLayouts.get(primaryFile) || [];
            return getSplitIndices(filePageCounts.get(primaryFile) || 0)
                .map((index) => layouts[index])
                .filter(Boolean);
        }

        if (mode.merge) {
            return selectedFiles.flatMap((file) => filePageLayouts.get(file) || []);
        }

        return primaryFile ? (filePageLayouts.get(primaryFile) || []) : [];
    };

    const getOutputPageCount = (mode) => {
        const layouts = getBaseOutputPageLayouts(mode);
        if (!getSpreadSplitState().enabled) {
            return layouts.length;
        }

        return layouts.reduce((total, layout) => total + (layout.isLandscape ? 2 : 1), 0);
    };

    const getOperationState = () => {
        const mode = getModeState();
        const pageSizeState = getPageSizeState();
        const pageSizeValidation = getPageSizeValidation();
        const spreadSplitState = getSpreadSplitState();
        const splitRange = document.getElementById('split-range').value.trim();
        const invalidMergeSplit = mode.merge && mode.split;
        const watermarkKind = getWatermarkKind();
        const primaryFile = getPrimaryFile();

        if (!mode.merge && !mode.split && !mode.watermark) {
            if (selectedFiles.length === 0) {
                return { valid: false, reason: '操作を選択するか、PDFをアップロードしてください。' };
            }

            if (selectedFiles.length > 1) {
                return { valid: false, reason: '複数PDFを扱うには結合を選択してください。' };
            }

            if (!pageSizeValidation.valid) {
                return { valid: false, reason: pageSizeValidation.reason, error: true };
            }

            if (pageNumberCheck.checked) {
                const outputPageCount = getOutputPageCount(mode);
                const startPage = Number(pageNumberStartPage.value);
                if (!Number.isInteger(startPage) || startPage < 1 || startPage > outputPageCount) {
                    return { valid: false, reason: `番号を付け始めるページは1〜${outputPageCount}の整数で指定してください。`, error: true };
                }
            }

            if (spreadSplitState.enabled) {
                return { valid: true, action: 'spread-split' };
            }

            if (pageSizeState.enabled) {
                return { valid: true, action: 'normalize' };
            }

            if (pageNumberCheck.checked) {
                return { valid: true, action: 'number' };
            }

            return { valid: true, action: 'passthrough' };
        }

        if (invalidMergeSplit) {
            return { valid: false, reason: '結合と分割は同時に選べません。', error: true };
        }

        if (selectedFiles.length > 1 && !mode.merge) {
            return { valid: false, reason: '複数PDFを扱うには結合を選択してください。', error: true };
        }

        if (mode.merge && selectedFiles.length === 0) {
            return { valid: false, reason: '結合する PDF を追加してください。' };
        }

        if (mode.split && !primaryFile) {
            return { valid: false, reason: '分割する PDF を選択してください。' };
        }

        if (mode.split && !splitRange) {
            return { valid: false, reason: '抽出範囲を入力してください。' };
        }

        if (mode.watermark && !primaryFile) {
            return { valid: false, reason: '元になる PDF を選択してください。' };
        }

        if (mode.watermark && watermarkKind === 'image' && !wmImgFile) {
            return { valid: false, reason: 'ウォーターマーク画像を選択してください。' };
        }

        if (mode.watermark && watermarkKind === 'image' && (!Number(wmWidth.value) || !Number(wmHeight.value))) {
            return { valid: false, reason: '画像サイズを確認してください。' };
        }

        if (mode.watermark && watermarkKind === 'text' && !wmText.value.trim()) {
            return { valid: false, reason: 'ウォーターマーク文字を入力してください。' };
        }

        if (!pageSizeValidation.valid) {
            return { valid: false, reason: pageSizeValidation.reason, error: true };
        }

        if (pageNumberCheck.checked) {
            const outputPageCount = getOutputPageCount(mode);
            const startPage = Number(pageNumberStartPage.value);
            if (!Number.isInteger(startPage) || startPage < 1 || startPage > outputPageCount) {
                return { valid: false, reason: `番号を付け始めるページは1〜${outputPageCount}の整数で指定してください。`, error: true };
            }
        }

        let action = 'watermark';
        if (mode.merge && mode.watermark) {
            action = 'merge-watermark';
        } else if (mode.split && mode.watermark) {
            action = 'split-watermark';
        } else if (mode.merge) {
            action = 'merge';
        } else if (mode.split) {
            action = 'split';
        }

        return { valid: true, action };
    };

    const getDownloadName = (action) => {
        const mergeName = document.getElementById('pdf-name').value.trim();
        const splitName = document.getElementById('split-name').value.trim();
        const wmName = document.getElementById('wm-name').value.trim();
        const splitRange = document.getElementById('split-range').value.trim();
        const primaryFile = getPrimaryFile();
        const withSpreadSplitSuffix = (name) => getSpreadSplitState().enabled
            ? `${name}_spread_split`
            : name;

        if (action === 'passthrough') {
            return primaryFile.name.replace(/\.pdf$/i, '');
        }

        if (action === 'number') {
            return `${primaryFile.name.replace(/\.pdf$/i, '')}_numbered`;
        }

        if (action === 'normalize') {
            return `${primaryFile.name.replace(/\.pdf$/i, '')}_resized`;
        }

        if (action === 'spread-split') {
            return `${primaryFile.name.replace(/\.pdf$/i, '')}_spread_split`;
        }

        if (action === 'merge') {
            if (mergeName) {
                return mergeName;
            }
            const generatedName = selectedFiles.length === 1
                ? `${selectedFiles[0].name.replace(/\.pdf$/i, '')}_numbered`
                : 'merged_numbered';
            return withSpreadSplitSuffix(generatedName);
        }

        if (action === 'split') {
            return splitName || withSpreadSplitSuffix(`${primaryFile.name.replace(/\.pdf$/i, '')}(${splitRange})`);
        }

        if (action === 'watermark') {
            return wmName || withSpreadSplitSuffix(`${primaryFile.name.replace(/\.pdf$/i, '')}_watermark`);
        }

        if (action === 'merge-watermark') {
            if (wmName || mergeName) {
                return wmName || `${mergeName}_watermark`;
            }
            const generatedName = selectedFiles.length === 1
                ? `${selectedFiles[0].name.replace(/\.pdf$/i, '')}_merged_watermark`
                : 'merged_watermark';
            return withSpreadSplitSuffix(generatedName);
        }

        return wmName
            || splitName
            || withSpreadSplitSuffix(`${primaryFile.name.replace(/\.pdf$/i, '')}_split_watermark`);
    };

    const buildResult = async () => {
        const operation = getOperationState();
        if (!operation.valid) {
            throw new Error(operation.reason);
        }

        let bytes;
        if (operation.action === 'merge' || operation.action === 'merge-watermark') {
            bytes = await getMergedBytes();
        } else if (operation.action === 'split' || operation.action === 'split-watermark') {
            bytes = await getSplitBytes();
        } else {
            bytes = await getPrimaryFile().arrayBuffer();
        }

        bytes = await applySpreadSplitToBytes(bytes);
        bytes = await applyPageSizeToBytes(bytes);
        if (getModeState().watermark) {
            bytes = await applyWatermarkToBytes(bytes);
        }
        bytes = await applyPageNumbersToBytes(bytes);

        return {
            bytes,
            name: getDownloadName(operation.action)
        };
    };

    const canvasToWebpBlob = (canvas, quality) => new Promise((resolve, reject) => {
        canvas.toBlob((blob) => {
            if (!blob) {
                reject(new Error('WebP画像の生成に失敗しました。ブラウザがWebP出力に対応しているか確認してください。'));
                return;
            }

            resolve(blob);
        }, 'image/webp', quality);
    });

    const buildWebpZipBlob = async (pdfBytes, baseName) => {
        if (!window.pdfjsLib || !window.JSZip) {
            throw new Error('WebP ZIP保存に必要なライブラリを読み込めませんでした。');
        }

        const { scale, quality } = getWebpQualitySettings();
        const zip = new JSZip();
        const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(pdfBytes) }).promise;
        const totalPages = pdf.numPages;
        const padLength = Math.max(3, String(totalPages).length);
        const entryBaseName = getSafeZipEntryName(baseName);

        for (let pageNumber = 1; pageNumber <= totalPages; pageNumber += 1) {
            setStatus(`WebP変換中: ${pageNumber} / ${totalPages} ページ`);
            const page = await pdf.getPage(pageNumber);
            const viewport = page.getViewport({ scale });
            const canvas = document.createElement('canvas');
            const context = canvas.getContext('2d');

            if (!context) {
                throw new Error('Canvasの生成に失敗しました。');
            }

            canvas.width = Math.ceil(viewport.width);
            canvas.height = Math.ceil(viewport.height);
            await page.render({ canvasContext: context, viewport }).promise;

            const webpBlob = await canvasToWebpBlob(canvas, quality);
            const suffix = String(pageNumber).padStart(padLength, '0');
            zip.file(`${entryBaseName}_page-${suffix}.webp`, webpBlob);
            canvas.width = 0;
            canvas.height = 0;
        }

        setStatus('ZIP生成中...');
        const zipBlob = await zip.generateAsync({ type: 'blob' });
        await pdf.destroy();
        return zipBlob;
    };

    const syncWatermarkUi = () => {
        const mode = getModeState();
        const watermarkKind = getWatermarkKind();

        if (mode.watermark) {
            const hasSource = Boolean(getPrimaryFile());
            wmInfo.style.display = hasSource ? 'block' : 'none';
            wmSettings.style.display = hasSource ? 'block' : 'none';
        } else {
            wmInfo.style.display = 'none';
            wmSettings.style.display = 'none';
        }

        wmImageFields.style.display = watermarkKind === 'image' ? 'flex' : 'none';
        wmTextFields.style.display = watermarkKind === 'text' ? 'flex' : 'none';
    };

    const syncUiState = () => {
        const mode = getModeState();
        const operation = getOperationState();
        const output = getOutputState();
        const hasOutput = output.pdf || output.webp;

        mergeSection.classList.toggle('hidden', !mode.merge);
        splitSection.classList.toggle('hidden', !mode.split);
        watermarkSection.classList.toggle('hidden', !mode.watermark);
        document.getElementById('split-info').style.display = getPrimaryFile() && mode.split ? 'block' : 'none';
        pageNumberPanel.classList.toggle('visible', selectedFiles.length > 0);
        pageNumberSettings.style.display = pageNumberCheck.checked ? 'flex' : 'none';
        pageSizePanel.classList.toggle('visible', selectedFiles.length > 0);
        pageSizeSettings.style.display = pageSizeCheck.checked ? 'flex' : 'none';
        spreadSplitPanel.classList.toggle('visible', selectedFiles.length > 0);
        spreadSplitSettings.style.display = spreadSplitCheck.checked ? 'flex' : 'none';
        const pageSizeState = getPageSizeState();
        const isReferenceTarget = pageSizeState.target === 'largest' || pageSizeState.target === 'smallest';
        const isOtherTarget = pageSizeState.target === 'other';
        const isCustomTarget = isOtherTarget && pageSizeState.otherPreset === 'custom';
        pageSizeOtherWrap.style.display = isOtherTarget ? 'flex' : 'none';
        pageSizeCustomWrap.style.display = isCustomTarget ? 'flex' : 'none';
        pageSizeOrientationWrap.style.display = (!isReferenceTarget && !isCustomTarget) ? 'flex' : 'none';
        webpQualityWrap.classList.toggle('hidden', !output.webp);

        syncWatermarkUi();

        previewBtn.disabled = !operation.valid;
        actionBtn.disabled = !operation.valid || !hasOutput;

        if (operation.valid && !hasOutput) {
            setStatus('保存形式を選択してください。', true);
        } else if (operation.valid) {
            const labelMap = {
                merge: '結合の準備ができています。',
                split: '分割の準備ができています。',
                watermark: 'ウォーターマーク追加の準備ができています。',
                number: 'ページ番号追加の準備ができています。',
                normalize: 'ページサイズ統一の準備ができています。',
                'spread-split': '横長ページを中央で分割する準備ができています。',
                passthrough: 'PDFをそのまま保存またはWebPに変換する準備ができています。',
                'merge-watermark': '結合してからウォーターマークを追加する準備ができています。',
                'split-watermark': '分割してからウォーターマークを追加する準備ができています。'
            };
            const baseLabel = labelMap[operation.action];
            const includesSpreadSplit = getSpreadSplitState().enabled && operation.action !== 'spread-split';
            setStatus(includesSpreadSplit ? `${baseLabel} 横長ページも中央で分割します。` : baseLabel);
        } else {
            setStatus(operation.reason, Boolean(operation.error));
        }
    };

    document.getElementById('pdf-inputs').onchange = async (e) => {
        const files = Array.from(e.target.files).filter((file) => file.type === 'application/pdf');
        await Promise.all(files.map(async (file) => {
            const doc = await PDFDocument.load(await file.arrayBuffer());
            filePageCounts.set(file, doc.getPageCount());
            filePageLayouts.set(file, doc.getPages().map(getVisiblePageLayout));
        }));
        selectedFiles = [...selectedFiles, ...files];

        if (selectedFiles.length > 1) {
            modeMerge.checked = true;
        }

        await updatePrimaryFileState(true);
        renderList();
        syncUiState();
    };

    wmImgInput.onchange = async (e) => {
        wmImgFile = e.target.files[0] || null;
        if (wmImgFile) {
            try {
                const sourceUrl = wmImgFile.type === 'image/svg+xml'
                    ? await loadFileAsDataUrl(wmImgFile)
                    : URL.createObjectURL(wmImgFile);
                const img = await loadImageElement(sourceUrl);
                wmOriginalWidth = img.naturalWidth || img.width;
                wmOriginalHeight = img.naturalHeight || img.height;
                wmScale.value = 100;
                wmScaleVal.textContent = '100%';
                wmWidth.value = wmOriginalWidth;
                wmHeight.value = wmOriginalHeight;
            } catch (error) {
                wmImgFile = null;
                wmOriginalWidth = 0;
                wmOriginalHeight = 0;
                wmWidth.value = '';
                wmHeight.value = '';
                setStatus(error.message || '画像の読み込みに失敗しました。', true);
            }
        } else {
            wmOriginalWidth = 0;
            wmOriginalHeight = 0;
            wmWidth.value = '';
            wmHeight.value = '';
        }
        syncUiState();
    };

    let isUpdatingSize = false;

    wmScale.oninput = (e) => {
        if (isUpdatingSize || !wmOriginalWidth || !wmOriginalHeight) {
            return;
        }

        isUpdatingSize = true;
        const scale = Number(e.target.value);
        wmScaleVal.textContent = `${scale}%`;
        wmWidth.value = Math.round(wmOriginalWidth * (scale / 100));
        wmHeight.value = Math.round(wmOriginalHeight * (scale / 100));
        isUpdatingSize = false;
        syncUiState();
    };

    wmWidth.oninput = (e) => {
        if (isUpdatingSize || !wmOriginalWidth) {
            return;
        }

        isUpdatingSize = true;
        const width = Number(e.target.value);
        if (width > 0) {
            const scale = (width / wmOriginalWidth) * 100;
            wmScale.value = scale;
            wmScaleVal.textContent = `${Math.round(scale)}%`;
            wmHeight.value = Math.round(wmOriginalHeight * (scale / 100));
        }
        isUpdatingSize = false;
        syncUiState();
    };

    wmHeight.oninput = (e) => {
        if (isUpdatingSize || !wmOriginalHeight) {
            return;
        }

        isUpdatingSize = true;
        const height = Number(e.target.value);
        if (height > 0) {
            const scale = (height / wmOriginalHeight) * 100;
            wmScale.value = scale;
            wmScaleVal.textContent = `${Math.round(scale)}%`;
            wmWidth.value = Math.round(wmOriginalWidth * (scale / 100));
        }
        isUpdatingSize = false;
        syncUiState();
    };

    wmOpacity.oninput = (e) => {
        wmOpacityVal.textContent = `${e.target.value}%`;
        syncUiState();
    };

    wmRotation.oninput = (e) => {
        wmRotationVal.textContent = `${e.target.value}°`;
        syncUiState();
    };

    pageSizeTargetInputs.forEach((input) => {
        input.addEventListener('change', () => {
            if (input.checked) {
                pageSizeTargetInputs.forEach((candidate) => {
                    if (candidate !== input) {
                        candidate.checked = false;
                    }
                });
            }
            syncUiState();
        });
    });

    [
        modeMerge,
        modeSplit,
        modeWatermark,
        wmType,
        wmText,
        wmFontSize,
        wmTextColor,
        document.getElementById('split-range'),
        pageNumberCheck,
        pageNumberStyle,
        pageNumberSize,
        pageNumberStartPage,
        pageSizeCheck,
        pageSizeDimension,
        pageSizeOrientation,
        pageSizeOtherPreset,
        pageSizeCustomWidth,
        pageSizeCustomHeight,
        spreadSplitCheck,
        spreadSplitOrder,
        outputPdfCheck,
        outputWebpCheck,
        webpQuality
    ].forEach((element) => {
        element.addEventListener('change', syncUiState);
        element.addEventListener('input', syncUiState);
    });

    previewBtn.onclick = async () => {
        try {
            const result = await buildResult();
            updateViewer(URL.createObjectURL(new Blob([result.bytes], { type: 'application/pdf' })));
        } catch (error) {
            setStatus(error.message || 'プレビューに失敗しました。', true);
        }
    };

    actionBtn.onclick = async () => {
        try {
            const output = getOutputState();
            const result = await buildResult();
            const pdfBlob = new Blob([result.bytes], { type: 'application/pdf' });
            const pdfUrl = URL.createObjectURL(pdfBlob);
            updateViewer(pdfUrl);

            if (output.pdf) {
                const a = document.createElement('a');
                a.href = pdfUrl;
                a.download = `${result.name}.pdf`;
                a.click();
            }

            if (output.webp) {
                const zipBlob = await buildWebpZipBlob(result.bytes, result.name);
                downloadBlob(zipBlob, `${getSafeZipEntryName(result.name)}.zip`);
            }

            setStatus('保存が完了しました。');
        } catch (error) {
            setStatus(error.message || '処理に失敗しました。', true);
        }
    };

    clearBtn.onclick = () => {
        if (!confirm('入力内容をクリアしますか？')) {
            return;
        }

        selectedFiles = [];
        wmImgFile = null;
        wmOriginalWidth = 0;
        wmOriginalHeight = 0;

        document.getElementById('pdf-inputs').value = '';
        wmImgInput.value = '';
        document.getElementById('pdf-name').value = '';
        document.getElementById('split-name').value = '';
        document.getElementById('split-range').value = '';
        document.getElementById('wm-name').value = '';
        document.getElementById('sp-count').textContent = '';
        modeMerge.checked = false;
        modeSplit.checked = false;
        modeWatermark.checked = false;
        pageNumberCheck.checked = false;
        pageNumberStyle.value = 'dash';
        pageNumberSize.value = '10';
        pageNumberStartPage.value = '1';
        pageSizeCheck.checked = false;
        pageSizeDimension.value = 'page';
        pageSizeTargetInputs.forEach((input) => {
            input.checked = input.value === 'largest';
        });
        pageSizeOrientation.value = 'portrait';
        pageSizeOtherPreset.value = 'A3';
        pageSizeCustomWidth.value = '210';
        pageSizeCustomHeight.value = '297';
        spreadSplitCheck.checked = false;
        spreadSplitOrder.value = 'right-first';
        outputPdfCheck.checked = true;
        outputWebpCheck.checked = false;
        webpQuality.value = 'standard';
        wmType.value = 'image';
        wmText.value = '';
        wmFontSize.value = 48;
        wmTextColor.value = '#808080';
        wmScale.value = 100;
        wmScaleVal.textContent = '100%';
        wmWidth.value = '';
        wmHeight.value = '';
        wmOpacity.value = 50;
        wmOpacityVal.textContent = '50%';
        wmRotation.value = 0;
        wmRotationVal.textContent = '0°';

        renderList();
        resetViewer();
        syncUiState();
    };

    renderList();
    syncUiState();
});
