import React, { useState, useRef } from 'react';
import { StyleSheet, View, TouchableOpacity, Text, Image, Dimensions, LayoutChangeEvent } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');
const FRAME_SIZE = 250;

// Frame position (centered on screen)
const FRAME_X = (SCREEN_WIDTH - FRAME_SIZE) / 2;
const FRAME_Y = (SCREEN_HEIGHT - FRAME_SIZE) / 2;

export default function GeminiCropCamera() {
    const [permission, requestPermission] = useCameraPermissions();
    const [croppedImage, setCroppedImage] = useState<string | null>(null);
    const [cameraLayout, setCameraLayout] = useState({ width: 0, height: 0 });
    const [pictureSizes, setPictureSizes] = useState<string[]>([]);
    const cameraRef = useRef<CameraView>(null);

    // Get available picture sizes when camera is ready
    const onCameraReady = async () => {
        if (cameraRef.current) {
            const sizes = await cameraRef.current.getAvailablePictureSizesAsync();
            console.log('Available picture sizes:', sizes);
            setPictureSizes(sizes);
        }
    };

    if (!permission?.granted) {
        return (
            <View style={styles.container}>
                <TouchableOpacity onPress={requestPermission} style={styles.btn}>
                    <Text>Grant Permission</Text>
                </TouchableOpacity>
            </View>
        );
    }

    const onCameraLayout = (event: LayoutChangeEvent) => {
        const { width, height } = event.nativeEvent.layout;
        setCameraLayout({ width, height });
    };

    const takeAndCropPhoto = async () => {
        if (!cameraRef.current) return;

        const photo = await cameraRef.current.takePictureAsync({
            quality: 1,
        });

        if (!photo) return;

        console.log('Photo dimensions:', photo.width, 'x', photo.height);
        console.log('Camera layout:', cameraLayout.width, 'x', cameraLayout.height);

        // Calculate how the camera preview maps to the photo
        // The camera preview fills the view, but photo might have different aspect ratio
        const previewAspect = cameraLayout.width / cameraLayout.height;
        const photoAspect = photo.width / photo.height;

        let scaleX: number, scaleY: number;
        let offsetX = 0, offsetY = 0;

        if (photoAspect > previewAspect) {
            // Photo is wider - it's cropped on the sides in preview
            scaleY = photo.height / cameraLayout.height;
            scaleX = scaleY;
            offsetX = (photo.width - cameraLayout.width * scaleX) / 2;
        } else {
            // Photo is taller - it's cropped on top/bottom in preview
            scaleX = photo.width / cameraLayout.width;
            scaleY = scaleX;
            offsetY = (photo.height - cameraLayout.height * scaleY) / 2;
        }

        const cropX = Math.max(0, FRAME_X * scaleX + offsetX);
        const cropY = Math.max(0, FRAME_Y * scaleY + offsetY);
        const cropWidth = Math.min(FRAME_SIZE * scaleX, photo.width - cropX);
        const cropHeight = Math.min(FRAME_SIZE * scaleY, photo.height - cropY);

        console.log('Crop dimensions:', cropWidth, 'x', cropHeight);

        const cropped = await manipulateAsync(
            photo.uri,
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

        console.log('Cropped image URI:', cropped.uri);
        setCroppedImage(cropped.uri);
    };

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
            <CameraView
                style={styles.camera}
                ref={cameraRef}
                onLayout={onCameraLayout}
                onCameraReady={onCameraReady}
                pictureSize="Photo"
                autofocus="on"
            >
                {/* Overlay with cutout */}
                <View style={styles.overlay} pointerEvents="none">
                    {/* Top */}
                    <View style={{ height: FRAME_Y, backgroundColor: 'rgba(0,0,0,0.6)' }} />
                    {/* Middle row */}
                    <View style={{ flexDirection: 'row', height: FRAME_SIZE }}>
                        <View style={{ width: FRAME_X, backgroundColor: 'rgba(0,0,0,0.6)' }} />
                        <View style={styles.frame} />
                        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.6)' }} />
                    </View>
                    {/* Bottom */}
                    <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', alignItems: 'center' }}>
                        <Text style={styles.hintText}>Align item inside the frame</Text>
                    </View>
                </View>

                <TouchableOpacity style={styles.captureBtn} onPress={takeAndCropPhoto}>
                    <View style={styles.captureInner} />
                </TouchableOpacity>
            </CameraView>
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
    camera: { flex: 1, width: '100%' },
    overlay: {
        ...StyleSheet.absoluteFillObject,
    },
    frame: {
        width: FRAME_SIZE,
        height: FRAME_SIZE,
        borderWidth: 2,
        borderColor: '#00FF00',
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
    btnText: { color: 'white', fontSize: 18, fontWeight: 'bold' },
});
