import React, { useState, useRef, useCallback } from 'react';
import { StyleSheet, View, TouchableOpacity, Text, Image, Dimensions } from 'react-native';
import { Camera, useCameraDevice, useCameraPermission, PhotoFile } from 'react-native-vision-camera';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

// ID card aspect ratio is approximately 1.586:1 (85.6mm x 53.98mm)
const FRAME_WIDTH = SCREEN_WIDTH - 40;
const FRAME_HEIGHT = FRAME_WIDTH / 1.586;

// Frame position (centered on screen)
const FRAME_X = (SCREEN_WIDTH - FRAME_WIDTH) / 2;
const FRAME_Y = (SCREEN_HEIGHT - FRAME_HEIGHT) / 2;

export default function VisionCropCamera() {
    const { hasPermission, requestPermission } = useCameraPermission();
    const device = useCameraDevice('back');
    const camera = useRef<Camera>(null);

    const [croppedImage, setCroppedImage] = useState<string | null>(null);
    const [cameraLayout, setCameraLayout] = useState({ width: 0, height: 0 });

    const onCameraLayout = useCallback((event: any) => {
        const { width, height } = event.nativeEvent.layout;
        setCameraLayout({ width, height });
    }, []);

    const takeAndCropPhoto = async () => {
        if (!camera.current) return;

        const photo = await camera.current.takePhoto({
            qualityPrioritization: 'quality',
            enableShutterSound: false,
        });

        console.log('Photo dimensions:', photo.width, 'x', photo.height);
        console.log('Photo orientation:', photo.orientation);
        console.log('Camera layout:', cameraLayout.width, 'x', cameraLayout.height);

        // Vision Camera reports raw dimensions (landscape) but expo-image-manipulator
        // applies EXIF rotation BEFORE cropping. So we need to use post-EXIF dimensions.
        // When orientation is landscape-left/right, the image gets rotated to portrait,
        // meaning width and height are swapped.
        const needsSwap = photo.orientation === 'landscape-left' || photo.orientation === 'landscape-right';
        const imageWidth = needsSwap ? photo.height : photo.width;
        const imageHeight = needsSwap ? photo.width : photo.height;

        console.log('Effective dimensions (post-EXIF):', imageWidth, 'x', imageHeight);

        const previewAspect = cameraLayout.width / cameraLayout.height;
        const photoAspect = imageWidth / imageHeight;

        let scaleX: number, scaleY: number;
        let offsetX = 0, offsetY = 0;

        if (photoAspect > previewAspect) {
            // Photo is wider - cropped on sides in preview
            scaleY = imageHeight / cameraLayout.height;
            scaleX = scaleY;
            offsetX = (imageWidth - cameraLayout.width * scaleX) / 2;
        } else {
            // Photo is taller - cropped on top/bottom in preview
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

        // NO rotation needed - expo-image-manipulator handles EXIF automatically
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
    };

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
                        onPress={() => setCroppedImage(null)}
                    >
                        <Text style={styles.btnText}>Retake Photo</Text>
                    </TouchableOpacity>
                </View>
            </View>
        );
    }

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
                    <View style={styles.frame} />
                    <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.6)' }} />
                </View>
                {/* Bottom */}
                <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', alignItems: 'center' }}>
                    <Text style={styles.hintText}>Align ID inside the frame</Text>
                </View>
            </View>

            <TouchableOpacity style={styles.captureBtn} onPress={takeAndCropPhoto}>
                <View style={styles.captureInner} />
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
        borderColor: '#00FF00',
        borderRadius: 8,
    },
    hintText: { color: 'white', marginTop: 20, fontWeight: 'bold' },
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
    captureInner: {
        width: 60,
        height: 60,
        borderRadius: 30,
        backgroundColor: 'white',
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
