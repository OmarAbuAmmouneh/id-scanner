import React, { useState, useRef, useCallback, useEffect } from 'react';
import { StyleSheet, View, TouchableOpacity, Text, Image, Dimensions, ActivityIndicator } from 'react-native';
import { Camera, useCameraDevice, useCameraPermission } from 'react-native-vision-camera';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import TextRecognition from '@react-native-ml-kit/text-recognition';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

// ID card aspect ratio is approximately 1.586:1 (85.6mm x 53.98mm)
const FRAME_WIDTH = SCREEN_WIDTH - 40;
const FRAME_HEIGHT = FRAME_WIDTH / 1.586;

// Frame position (centered on screen)
const FRAME_X = (SCREEN_WIDTH - FRAME_WIDTH) / 2;
const FRAME_Y = (SCREEN_HEIGHT - FRAME_HEIGHT) / 2;

// OCR scanning interval
const OCR_SCAN_INTERVAL = 2000; // ms between OCR scans

export default function VisionCropCamera() {
    const { hasPermission, requestPermission } = useCameraPermission();
    const device = useCameraDevice('back');
    const camera = useRef<Camera>(null);

    const [croppedImage, setCroppedImage] = useState<string | null>(null);
    const [cameraLayout, setCameraLayout] = useState({ width: 0, height: 0 });

    // Detection state
    const [textDetected, setTextDetected] = useState(false);
    const [isScanning, setIsScanning] = useState(false);
    const [statusMessage, setStatusMessage] = useState('Scanning for ID...');
    const [nationalId, setNationalId] = useState<string | null>(null);

    // Refs for tracking
    const isOcrRunning = useRef(false);
    const isCapturing = useRef(false);

    const onCameraLayout = useCallback((event: any) => {
        const { width, height } = event.nativeEvent.layout;
        setCameraLayout({ width, height });
    }, []);

    // Get frame color based on detection state
    const getFrameColor = () => {
        if (textDetected) {
            return '#00FF00'; // Green - ID detected
        }
        return '#FFFFFF'; // White - scanning
    };

    const takeAndCropPhoto = async () => {
        if (!camera.current || isCapturing.current) return;

        isCapturing.current = true;
        setStatusMessage('Capturing...');

        try {
            const photo = await camera.current.takePhoto({
                flash: 'off',
                enableShutterSound: false,
            });

            console.log('Photo dimensions:', photo.width, 'x', photo.height);
            console.log('Photo orientation:', photo.orientation);
            console.log('Camera layout:', cameraLayout.width, 'x', cameraLayout.height);

            // Vision Camera reports raw dimensions (landscape) but expo-image-manipulator
            // applies EXIF rotation BEFORE cropping. So we need to use post-EXIF dimensions.
            const needsSwap = photo.orientation === 'landscape-left' || photo.orientation === 'landscape-right';
            const imageWidth = needsSwap ? photo.height : photo.width;
            const imageHeight = needsSwap ? photo.width : photo.height;

            console.log('Effective dimensions (post-EXIF):', imageWidth, 'x', imageHeight);

            const previewAspect = cameraLayout.width / cameraLayout.height;
            const photoAspect = imageWidth / imageHeight;

            let scaleX: number, scaleY: number;
            let offsetX = 0, offsetY = 0;

            if (photoAspect > previewAspect) {
                scaleY = imageHeight / cameraLayout.height;
                scaleX = scaleY;
                offsetX = (imageWidth - cameraLayout.width * scaleX) / 2;
            } else {
                scaleX = imageWidth / cameraLayout.width;
                scaleY = scaleX;
                offsetY = (imageHeight - cameraLayout.height * scaleY) / 2;
            }

            const cropX = Math.max(0, FRAME_X * scaleX + offsetX);
            const cropY = Math.max(0, FRAME_Y * scaleY + offsetY);
            const cropWidth = Math.min(FRAME_WIDTH * scaleX, imageWidth - cropX);
            const cropHeight = Math.min(FRAME_HEIGHT * scaleY, imageHeight - cropY);

            console.log('Crop region:', { cropX, cropY, cropWidth, cropHeight });

            const photoUri = `file://${photo.path}`;

            const cropped = await manipulateAsync(
                photoUri,
                [{
                    crop: {
                        originX: Math.round(cropX),
                        originY: Math.round(cropY),
                        width: Math.round(cropWidth),
                        height: Math.round(cropHeight),
                    }
                }],
                { compress: 1, format: SaveFormat.PNG }
            );

            setCroppedImage(cropped.uri);
        } catch (error) {
            console.error('Capture error:', error);
        } finally {
            isCapturing.current = false;
            // Reset detection state
            setTextDetected(false);
        }
    };

    // Periodic OCR scanning
    useEffect(() => {
        if (croppedImage) return; // Don't scan when showing preview
        if (!device || !hasPermission) return; // Don't scan without camera device or permission

        let isMounted = true;
        let interval: ReturnType<typeof setInterval> | null = null;

        const runOcr = async () => {
            if (!isMounted) return;
            if (isOcrRunning.current || !camera.current || isCapturing.current) return;

            isOcrRunning.current = true;
            setIsScanning(true);

            try {
                const photo = await camera.current.takePhoto({
                    flash: 'off',
                    enableShutterSound: false,
                });

                if (!isMounted) return;

                const result = await TextRecognition.recognize(`file://${photo.path}`);
                const text = result.text;
                const textLower = text.toLowerCase();

                // Look for 10-digit national ID number and "hashemite" keyword
                const nationalIdMatch = text.match(/\d{10}/);
                const hasHashemite = textLower.includes('hashemite');

                if (nationalIdMatch && hasHashemite && isMounted) {
                    console.log('National ID detected:', nationalIdMatch[0]);
                    setNationalId(nationalIdMatch[0]);
                    setTextDetected(true);
                    setStatusMessage('ID detected! Capturing...');
                }
            } catch (e) {
                console.log('OCR error:', e);
            } finally {
                isOcrRunning.current = false;
                if (isMounted) {
                    setIsScanning(false);
                }
            }
        };

        // Wait for camera to initialize before starting OCR
        const startDelay = setTimeout(() => {
            if (isMounted) {
                runOcr();
                interval = setInterval(runOcr, OCR_SCAN_INTERVAL);
            }
        }, 1500); // Give camera 1.5s to initialize

        return () => {
            isMounted = false;
            clearTimeout(startDelay);
            if (interval) clearInterval(interval);
        };
    }, [croppedImage, device, hasPermission]);

    // Auto-capture when text is detected
    useEffect(() => {
        if (textDetected && !croppedImage && !isCapturing.current) {
            takeAndCropPhoto();
        }
    }, [textDetected, croppedImage]);

    // --- PERMISSION SCREEN ---
    if (!hasPermission) {
        return (
            <View style={styles.container}>
                <TouchableOpacity onPress={requestPermission} style={styles.btn}>
                    <Text style={styles.btnText}>Grant Camera Permission</Text>
                </TouchableOpacity>
            </View>
        );
    }

    // --- NO DEVICE ---
    if (!device) {
        return (
            <View style={styles.container}>
                <Text style={styles.errorText}>No camera device found</Text>
            </View>
        );
    }

    // --- PREVIEW SCREEN ---
    if (croppedImage) {
        return (
            <View style={styles.container}>
                <Image
                    source={{ uri: croppedImage }}
                    style={styles.previewImage}
                    resizeMode="contain"
                />

                <View style={styles.buttonContainer}>
                    <TouchableOpacity
                        style={styles.retakeBtn}
                        onPress={() => {
                            setCroppedImage(null);
                            setNationalId(null);
                        }}
                    >
                        <Text style={styles.btnText}>Retake Photo</Text>
                    </TouchableOpacity>
                </View>
            </View>
        );
    }

    const frameColor = getFrameColor();

    // --- CAMERA SCREEN ---
    return (
        <View style={styles.container}>
            <Camera
                ref={camera}
                style={StyleSheet.absoluteFill}
                device={device}
                isActive={true}
                photo={true}
                onLayout={onCameraLayout}
            />

            {/* Overlay with cutout */}
            <View style={styles.overlay} pointerEvents="none">
                {/* Top */}
                <View style={{ height: FRAME_Y, backgroundColor: 'rgba(0,0,0,0.6)' }} />
                {/* Middle row */}
                <View style={{ flexDirection: 'row', height: FRAME_HEIGHT }}>
                    <View style={{ width: FRAME_X, backgroundColor: 'rgba(0,0,0,0.6)' }} />
                    <View style={[styles.frame, { borderColor: frameColor }]}>
                        {/* Corner indicators */}
                        <View style={[styles.corner, styles.cornerTopLeft, { borderColor: frameColor }]} />
                        <View style={[styles.corner, styles.cornerTopRight, { borderColor: frameColor }]} />
                        <View style={[styles.corner, styles.cornerBottomLeft, { borderColor: frameColor }]} />
                        <View style={[styles.corner, styles.cornerBottomRight, { borderColor: frameColor }]} />
                    </View>
                    <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.6)' }} />
                </View>
                {/* Bottom */}
                <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', alignItems: 'center' }}>
                    {/* Status message */}
                    <View style={[
                        styles.statusContainer,
                        textDetected && styles.statusContainerReady,
                    ]}>
                        {isScanning && !textDetected && (
                            <ActivityIndicator size="small" color="#FFFFFF" style={{ marginRight: 8 }} />
                        )}
                        <Text style={styles.statusText}>{statusMessage}</Text>
                    </View>
                </View>
            </View>

            {/* Manual capture button (always available) */}
            <TouchableOpacity
                style={[
                    styles.captureBtn,
                    textDetected && styles.captureBtnReady,
                ]}
                onPress={takeAndCropPhoto}
                disabled={isCapturing.current}
            >
                <View style={[
                    styles.captureInner,
                    textDetected && styles.captureInnerReady,
                ]} />
            </TouchableOpacity>
        </View>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: 'black' },
    btn: {
        backgroundColor: '#007AFF',
        padding: 15,
        borderRadius: 10,
        position: 'absolute',
        top: '50%',
        alignSelf: 'center',
    },
    btnText: { color: 'white', fontSize: 18, fontWeight: 'bold' },
    errorText: { color: 'white', fontSize: 16, textAlign: 'center', marginTop: '50%' },
    overlay: {
        ...StyleSheet.absoluteFillObject,
    },
    frame: {
        width: FRAME_WIDTH,
        height: FRAME_HEIGHT,
        borderWidth: 2,
        borderRadius: 8,
    },
    corner: {
        position: 'absolute',
        width: 24,
        height: 24,
        borderWidth: 3,
    },
    cornerTopLeft: {
        top: -2,
        left: -2,
        borderRightWidth: 0,
        borderBottomWidth: 0,
        borderTopLeftRadius: 8,
    },
    cornerTopRight: {
        top: -2,
        right: -2,
        borderLeftWidth: 0,
        borderBottomWidth: 0,
        borderTopRightRadius: 8,
    },
    cornerBottomLeft: {
        bottom: -2,
        left: -2,
        borderRightWidth: 0,
        borderTopWidth: 0,
        borderBottomLeftRadius: 8,
    },
    cornerBottomRight: {
        bottom: -2,
        right: -2,
        borderLeftWidth: 0,
        borderTopWidth: 0,
        borderBottomRightRadius: 8,
    },
    statusContainer: {
        marginTop: 20,
        backgroundColor: 'rgba(0,0,0,0.7)',
        paddingHorizontal: 16,
        paddingVertical: 10,
        borderRadius: 8,
        flexDirection: 'row',
        alignItems: 'center',
    },
    statusContainerReady: {
        backgroundColor: 'rgba(0, 128, 0, 0.9)',
    },
    statusText: {
        color: 'white',
        fontWeight: 'bold',
        fontSize: 16,
    },
    captureBtn: {
        position: 'absolute',
        bottom: 40,
        alignSelf: 'center',
        width: 80,
        height: 80,
        borderRadius: 40,
        borderWidth: 4,
        borderColor: 'white',
        justifyContent: 'center',
        alignItems: 'center',
    },
    captureBtnReady: {
        borderColor: '#00FF00',
    },
    captureInner: {
        width: 60,
        height: 60,
        borderRadius: 30,
        backgroundColor: 'white',
    },
    captureInnerReady: {
        backgroundColor: '#00FF00',
    },
    previewImage: {
        flex: 1,
        width: '100%',
    },
    buttonContainer: {
        position: 'absolute',
        bottom: 50,
        width: '100%',
        alignItems: 'center',
    },
    retakeBtn: {
        backgroundColor: '#FF3B30',
        paddingVertical: 15,
        paddingHorizontal: 30,
        borderRadius: 10,
    },
});
