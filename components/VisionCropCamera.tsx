import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Dimensions, Image, Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Camera, useCameraDevice, useCameraPermission, useFrameProcessor } from 'react-native-vision-camera';
import { useTextRecognition } from 'react-native-vision-camera-text-recognition';
import { useRunOnJS } from 'react-native-worklets-core';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

// ID card aspect ratio is approximately 1.586:1 (85.6mm x 53.98mm)
const FRAME_WIDTH = SCREEN_WIDTH - 40;
const FRAME_HEIGHT = FRAME_WIDTH / 1.586;

// Frame position (centered on screen)
const FRAME_X = (SCREEN_WIDTH - FRAME_WIDTH) / 2;
const FRAME_Y = (SCREEN_HEIGHT - FRAME_HEIGHT) / 2;

// Padding factor to expand detection bounds (20% on each side)
const BOUNDS_PADDING = 0.2;

// Hold steady duration in milliseconds before capture
const HOLD_DURATION_MS = 1000;

// Grace period - how long detection can be lost before resetting (prevents flicker)
const DETECTION_GRACE_MS = 300;

// Detection phases
type DetectionPhase = 'scanning' | 'holding' | 'ready';

// Helper to get the frame region bounds in frame coordinates
const getFrameBounds = (frameWidth: number, frameHeight: number) => {
    'worklet';
    const screenAspect = SCREEN_WIDTH / SCREEN_HEIGHT;
    const frameAspect = frameWidth / frameHeight;

    let scaleX: number, scaleY: number;
    let offsetX = 0, offsetY = 0;

    if (frameAspect > screenAspect) {
        scaleY = frameHeight / SCREEN_HEIGHT;
        scaleX = scaleY;
        offsetX = (frameWidth - SCREEN_WIDTH * scaleX) / 2;
    } else {
        scaleX = frameWidth / SCREEN_WIDTH;
        scaleY = scaleX;
        offsetY = (frameHeight - SCREEN_HEIGHT * scaleY) / 2;
    }

    // Calculate base bounds
    const left = FRAME_X * scaleX + offsetX;
    const top = FRAME_Y * scaleY + offsetY;
    const right = (FRAME_X + FRAME_WIDTH) * scaleX + offsetX;
    const bottom = (FRAME_Y + FRAME_HEIGHT) * scaleY + offsetY;

    // Calculate padding amounts
    const horizontalPadding = (right - left) * BOUNDS_PADDING;
    const verticalPadding = (bottom - top) * BOUNDS_PADDING;

    // Return expanded bounds
    return {
        left: left - horizontalPadding,
        top: top - verticalPadding,
        right: right + horizontalPadding,
        bottom: bottom + verticalPadding,
    };
};

// Check if a point is within the frame bounds
const isWithinFrame = (
    x: number,
    y: number,
    bounds: { left: number; top: number; right: number; bottom: number }
) => {
    'worklet';
    return x >= bounds.left && x <= bounds.right && y >= bounds.top && y <= bounds.bottom;
};

export default function VisionCropCamera() {
    const { hasPermission, requestPermission } = useCameraPermission();
    const device = useCameraDevice('back');
    const camera = useRef<Camera>(null);

    const [croppedImage, setCroppedImage] = useState<string | null>(null);
    const [cameraLayout, setCameraLayout] = useState({ width: 0, height: 0 });
    const [isCameraActive, setIsCameraActive] = useState(true);

    // Detection state
    const [detectionPhase, setDetectionPhase] = useState<DetectionPhase>('scanning');
    const [statusMessage, setStatusMessage] = useState('Scanning for ID...');

    // Refs for tracking
    const isCapturing = useRef(false);
    const holdStartTime = useRef<number | null>(null);
    const lastDetectionTime = useRef<number | null>(null);

    // Text recognition hook
    const { scanText } = useTextRecognition({ language: 'latin' });

    const onCameraLayout = useCallback((event: any) => {
        const { width, height } = event.nativeEvent.layout;
        setCameraLayout({ width, height });
    }, []);

    // Get frame color based on detection phase
    const getFrameColor = () => {
        switch (detectionPhase) {
            case 'holding':
                return '#FFA500'; // Orange - hold steady
            case 'ready':
                return '#00FF00'; // Green - ready to capture
            default:
                return '#FFFFFF'; // White - scanning
        }
    };

    const takeAndCropPhoto = useCallback(async () => {
        if (!camera.current || isCapturing.current) return;

        isCapturing.current = true;
        setStatusMessage('Capturing...');

        try {
            const photo = await camera.current.takePhoto({
                flash: 'off',
                enableShutterSound: false,
            });

            let imageWidth: number;
            let imageHeight: number;

            if (Platform.OS === 'ios') {
                // iOS: Vision Camera reports raw dimensions (landscape) but expo-image-manipulator
                // applies EXIF rotation BEFORE cropping. So we need to use post-EXIF dimensions.
                const needsSwap = photo.orientation === 'landscape-left' || photo.orientation === 'landscape-right';
                imageWidth = needsSwap ? photo.height : photo.width;
                imageHeight = needsSwap ? photo.width : photo.height;
            } else {
                // Android: Use dimensions as reported - expo-image-manipulator handles rotation
                // Photos are typically already in correct orientation or rotated by the library
                imageWidth = photo.width;
                imageHeight = photo.height;

                // If photo is landscape but screen is portrait, swap
                if (imageWidth > imageHeight && cameraLayout.height > cameraLayout.width) {
                    imageWidth = photo.height;
                    imageHeight = photo.width;
                }
            }

            const previewAspect = cameraLayout.width / cameraLayout.height;
            const photoAspect = imageWidth / imageHeight;

            let scaleX: number, scaleY: number;
            let offsetX = 0, offsetY = 0;

            if (photoAspect > previewAspect) {
                // Photo is wider than preview - crop sides
                scaleY = imageHeight / cameraLayout.height;
                scaleX = scaleY;
                offsetX = (imageWidth - cameraLayout.width * scaleX) / 2;
            } else {
                // Photo is taller than preview - crop top/bottom
                scaleX = imageWidth / cameraLayout.width;
                scaleY = scaleX;
                offsetY = (imageHeight - cameraLayout.height * scaleY) / 2;
            }

            const cropX = Math.max(0, FRAME_X * scaleX + offsetX);
            const cropY = Math.max(0, FRAME_Y * scaleY + offsetY);
            const cropWidth = Math.min(FRAME_WIDTH * scaleX, imageWidth - cropX);
            const cropHeight = Math.min(FRAME_HEIGHT * scaleY, imageHeight - cropY);

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

            setIsCameraActive(false);
            setCroppedImage(cropped.uri);
        } catch (error) {
            // Capture failed
        } finally {
            isCapturing.current = false;
            // Reset detection state
            setDetectionPhase('scanning');
            holdStartTime.current = null;
            lastDetectionTime.current = null;
        }
    }, [cameraLayout]);

    // Callback when ID is detected - start or continue holding
    const onDetectionSuccess = useCallback(() => {
        if (isCapturing.current) return;
        
        const now = Date.now();
        lastDetectionTime.current = now;
        
        // Start hold timer if not already started
        if (holdStartTime.current === null) {
            holdStartTime.current = now;
            setDetectionPhase('holding');
            setStatusMessage('Hold steady...');
        } else {
            // Check if hold duration has passed
            const elapsed = now - holdStartTime.current;
            if (elapsed >= HOLD_DURATION_MS) {
                setDetectionPhase('ready');
                setStatusMessage('Capturing...');
            }
        }
    }, []);

    // Callback when detection is lost - reset only after grace period
    const onDetectionMissed = useCallback(() => {
        if (isCapturing.current) return;
        if (holdStartTime.current === null) return; // Already in scanning state
        
        const now = Date.now();
        const lastDetection = lastDetectionTime.current || 0;
        const timeSinceLastDetection = now - lastDetection;
        
        // Only reset if grace period has elapsed
        if (timeSinceLastDetection >= DETECTION_GRACE_MS) {
            holdStartTime.current = null;
            lastDetectionTime.current = null;
            setDetectionPhase('scanning');
            setStatusMessage('Scanning for ID...');
        }
    }, []);

    const runOnDetectionSuccess = useRunOnJS(onDetectionSuccess, [onDetectionSuccess]);
    const runOnDetectionMissed = useRunOnJS(onDetectionMissed, [onDetectionMissed]);

    // Frame processor for real-time OCR
    const frameProcessor = useFrameProcessor((frame) => {
        'worklet';

        const result = scanText(frame) as any;

        let idDetected = false;

        if (result?.blocks && result.blocks.length > 0) {
            // Get the frame bounds to filter text blocks
            const bounds = getFrameBounds(frame.width, frame.height);

            // Filter blocks to only include those within the frame area
            const filteredText: string[] = [];
            for (const block of result.blocks) {
                // Check if the block's center is within the frame bounds
                const blockFrame = block.blockFrame;
                if (blockFrame) {
                    const centerX = blockFrame.boundingCenterX || (blockFrame.x + blockFrame.width / 2);
                    const centerY = blockFrame.boundingCenterY || (blockFrame.y + blockFrame.height / 2);

                    if (isWithinFrame(centerX, centerY, bounds)) {
                        if (block.blockText) {
                            filteredText.push(block.blockText);
                        }
                    }
                }
            }

            if (filteredText.length > 0) {
                const text = filteredText.join(' ');
                const textLower = text.toLowerCase();

                // Check for all required patterns:
                // 1. 10-digit national ID
                // 2. "name" keyword
                // 3. "hashemite" keyword
                const nationalIdMatch = text.match(/\d{10}/);
                const hasName = textLower.includes('name');
                const hasHashemite = textLower.includes('hashemite');
                
                if (nationalIdMatch && hasName && hasHashemite) {
                    idDetected = true;
                    runOnDetectionSuccess();
                }
            }
        }

        // If ID not detected in this frame, check if we should reset
        if (!idDetected) {
            runOnDetectionMissed();
        }
    }, [scanText, runOnDetectionSuccess, runOnDetectionMissed]);

    // Auto-capture when ready phase is reached
    useEffect(() => {
        if (detectionPhase === 'ready' && !croppedImage && !isCapturing.current) {
            takeAndCropPhoto();
        }
    }, [detectionPhase, croppedImage, takeAndCropPhoto]);

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
                            setStatusMessage('Scanning for ID...');
                            setDetectionPhase('scanning');
                            holdStartTime.current = null;
                            lastDetectionTime.current = null;
                            // Re-enable camera after a brief delay to let it reinitialize
                            setTimeout(() => {
                                setIsCameraActive(true);
                            }, 100);
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
                isActive={isCameraActive}
                photo={true}
                onLayout={onCameraLayout}
                frameProcessor={isCameraActive ? frameProcessor : undefined}
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
                        detectionPhase === 'holding' && styles.statusContainerHolding,
                        detectionPhase === 'ready' && styles.statusContainerReady,
                    ]}>
                        {detectionPhase === 'scanning' && (
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
                    detectionPhase === 'holding' && styles.captureBtnHolding,
                    detectionPhase === 'ready' && styles.captureBtnReady,
                ]}
                onPress={takeAndCropPhoto}
                disabled={isCapturing.current}
            >
                <View style={[
                    styles.captureInner,
                    detectionPhase === 'holding' && styles.captureInnerHolding,
                    detectionPhase === 'ready' && styles.captureInnerReady,
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
    statusContainerHolding: {
        backgroundColor: 'rgba(255, 165, 0, 0.9)',
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
    captureBtnHolding: {
        borderColor: '#FFA500',
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
    captureInnerHolding: {
        backgroundColor: '#FFA500',
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
