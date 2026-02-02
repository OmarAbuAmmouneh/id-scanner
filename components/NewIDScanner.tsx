import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import React, { useCallback, useRef, useState } from 'react';
import {
    ActivityIndicator,
    Image,
    StyleSheet,
    Text,
    TouchableOpacity,
    View,
} from 'react-native';
import { Camera, useCameraDevice } from 'react-native-vision-camera';

export default function NewIDScanner() {
  const OVERLAY_SIZE = 300;
  const cameraRef = useRef<Camera>(null);
  const device = useCameraDevice('back');
  const [isCapturing, setIsCapturing] = useState(false);
  const [capturedPhoto, setCapturedPhoto] = useState<string | null>(null);
  const [previewSize, setPreviewSize] = useState({ width: 0, height: 0 });

  const captureAgain = useCallback(() => {
    setCapturedPhoto(null);
  }, []);

  const rotationByOrientation: Record<string, number> = {
    portrait: 0,
    'portrait-upside-down': 180,
    'landscape-left': 90,
    'landscape-right': 270,
  };

  const handlePreviewLayout = useCallback((event: any) => {
    const { width, height } = event.nativeEvent.layout;
    if (!width || !height) return;
    if (width !== previewSize.width || height !== previewSize.height) {
      setPreviewSize({ width, height });
    }
  }, [previewSize.height, previewSize.width]);

  const capturePhoto = useCallback(async () => {
    if (!cameraRef.current || isCapturing) return;
    setIsCapturing(true);
    try {
      const photo = await cameraRef.current.takePhoto({
        flash: 'off',
        enableShutterSound: true,
      });
  
      const uri = `file://${photo.path}`;
      const rotation = rotationByOrientation[photo.orientation] ?? 0;
      const context = ImageManipulator.manipulate(uri);
      if (rotation !== 0) {
        context.rotate(rotation);
      }

      const image = await context.renderAsync();
      const rotated = await image.saveAsync({ format: SaveFormat.PNG, compress: 1 });

      context.release();
      image.release();

      const { width: imgW, height: imgH } = await new Promise<{
        width: number;
        height: number;
      }>((resolve, reject) => {
        Image.getSize(rotated.uri, (width, height) => resolve({ width, height }), reject);
      });

      const previewW = previewSize.width || imgW;
      const previewH = previewSize.height || imgH;
      const scale = Math.min(previewW / imgW, previewH / imgH);
      const visibleW = imgW * scale;
      const visibleH = imgH * scale;
      const offsetX = (previewW - visibleW) / 2;
      const offsetY = (previewH - visibleH) / 2;

      const frameX = (previewW - OVERLAY_SIZE) / 2;
      const frameY = (previewH - OVERLAY_SIZE) / 2;

      const rawCropX = (frameX - offsetX) / scale;
      const rawCropY = (frameY - offsetY) / scale;
      const rawCropW = OVERLAY_SIZE / scale;
      const rawCropH = OVERLAY_SIZE / scale;

      const originX = Math.max(0, Math.min(Math.round(rawCropX), imgW - 1));
      const originY = Math.max(0, Math.min(Math.round(rawCropY), imgH - 1));
      const width = Math.min(Math.round(rawCropW), imgW - originX);
      const height = Math.min(Math.round(rawCropH), imgH - originY);

      const cropContext = ImageManipulator.manipulate(rotated.uri);
      cropContext.crop({ originX, originY, width, height });
      const croppedImage = await cropContext.renderAsync();
      const result = await croppedImage.saveAsync({
        format: SaveFormat.PNG,
        compress: 1,
      });

      cropContext.release();
      croppedImage.release();

      setCapturedPhoto(result.uri);

    } catch (error) {
      console.error('Capture error:', error);
    } finally {
      setIsCapturing(false);
    }
  }, [isCapturing, previewSize.height, previewSize.width]);
  if (capturedPhoto) {
    return (
      <View style={styles.previewContainer}>
        <Image source={{ uri: capturedPhoto }} style={styles.previewImage} resizeMode="contain" />
        <TouchableOpacity style={styles.retakeButton} onPress={captureAgain}>
          <Text style={styles.retakeText}>Capture Again</Text>
        </TouchableOpacity>
      </View>
    );
  }
  return (
    <View style={styles.container} onLayout={handlePreviewLayout}>
      <Camera
        ref={cameraRef}
        style={StyleSheet.absoluteFill}
        device={device!}
        zoom={1}
        isActive={true}
        photo={true}
        resizeMode="contain"
      />
      {/* 4. The Overlay UI */}
      <View style={styles.overlay} />
      <View style={styles.captureContainer}>
        <TouchableOpacity
          style={[styles.captureButton, isCapturing && styles.captureButtonDisabled]}
          onPress={capturePhoto}
          disabled={isCapturing}
          activeOpacity={0.7}
        >
          {isCapturing ? (
            <ActivityIndicator size="small" color="#000000" />
          ) : (
            <View style={styles.captureButtonInner} />
          )}
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000000' },
  overlay: {
    position: 'absolute',
    width: 300,
    height: 300,
    borderWidth: 2,
    borderColor: 'white',
    alignSelf: 'center',
    top: '50%',
    marginTop: -150,
  },
  captureContainer: {
    position: 'absolute',
    bottom: 60,
    alignItems: 'center',
    alignSelf: 'center',
  },
  captureButton: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: '#FFFFFF',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 4,
    borderColor: 'rgba(255, 255, 255, 0.5)',
  },
  captureButtonDisabled: {
    opacity: 0.5,
  },
  captureButtonInner: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: '#FFFFFF',
    borderWidth: 2,
    borderColor: '#CCCCCC',
  },
  previewContainer: {
    flex: 1,
    backgroundColor: '#000000',
    paddingVertical: 24,
    paddingHorizontal: 16,
  },
  previewImage: {
    flex: 1,
    width: '100%',
    height: '100%',
  },
  retakeButton: {
    marginTop: 16,
    alignSelf: 'center',
    backgroundColor: '#FFFFFF',
    paddingHorizontal: 28,
    paddingVertical: 12,
    borderRadius: 24,
  },
  retakeText: {
    color: '#000000',
    fontSize: 16,
    fontWeight: '600',
  },
});
