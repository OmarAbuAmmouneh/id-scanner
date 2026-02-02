import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import ImageUtils from 'react-native-photo-manipulator';
import {
  Camera,
  Templates,
  useCameraDevice,
  useCameraFormat,
  useCameraPermission,
} from 'react-native-vision-camera';

type RectPercentage = {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
};

type CameraOverlayCropProps = {
  rectPercentage?: RectPercentage;
  resizeMode?: 'cover' | 'contain';
};

const DEFAULT_RECT: RectPercentage = { x1: 0.1, y1: 0.3, x2: 0.9, y2: 0.7 };

export default function CameraOverlayCrop({
  rectPercentage = DEFAULT_RECT,
  resizeMode = 'cover',
}: CameraOverlayCropProps) {
  const cameraRef = useRef<Camera>(null);
  const device = useCameraDevice('back');
  const { hasPermission, requestPermission } = useCameraPermission();
  const format = useCameraFormat(device, Templates.FrameProcessing);

  const [isCameraInitialized, setIsCameraInitialized] = useState(Platform.OS !== 'ios');
  const [isCameraActive, setIsCameraActive] = useState(false);
  const [reviewImage, setReviewImage] = useState<string | null>(null);
  const [cameraLayout, setCameraLayout] = useState({ width: 0, height: 0 });

  useEffect(() => {
    if (!hasPermission) {
      requestPermission();
    }
  }, [hasPermission, requestPermission]);

  useEffect(() => {
    if (hasPermission) {
      setIsCameraActive(true);
    }
  }, [hasPermission]);

  const rect = useMemo(() => {
    const x1 = Math.max(0, Math.min(rectPercentage.x1, 1));
    const y1 = Math.max(0, Math.min(rectPercentage.y1, 1));
    const x2 = Math.max(0, Math.min(rectPercentage.x2, 1));
    const y2 = Math.max(0, Math.min(rectPercentage.y2, 1));
    return {
      x1: Math.min(x1, x2),
      y1: Math.min(y1, y2),
      x2: Math.max(x1, x2),
      y2: Math.max(y1, y2),
    };
  }, [rectPercentage]);

  const overlayStyle = useMemo(() => {
    if (!cameraLayout.width || !cameraLayout.height) return null;
    return {
      left: rect.x1 * cameraLayout.width,
      top: rect.y1 * cameraLayout.height,
      width: (rect.x2 - rect.x1) * cameraLayout.width,
      height: (rect.y2 - rect.y1) * cameraLayout.height,
    };
  }, [cameraLayout.height, cameraLayout.width, rect.x1, rect.x2, rect.y1, rect.y2]);

  const grabImage = useCallback(async () => {
    if (!isCameraInitialized || !isCameraActive || !cameraRef.current) return;

    try {
      const photo = await cameraRef.current.takePhoto({ enableShutterSound: true });
      const previewW = cameraLayout.width || photo.width;
      const previewH = cameraLayout.height || photo.height;
      const scale =
        resizeMode === 'cover'
          ? Math.max(previewW / photo.width, previewH / photo.height)
          : Math.min(previewW / photo.width, previewH / photo.height);
      const visibleW = photo.width * scale;
      const visibleH = photo.height * scale;
      const offsetX = (previewW - visibleW) / 2;
      const offsetY = (previewH - visibleH) / 2;

      const rawX = (rect.x1 * previewW - offsetX) / scale;
      const rawY = (rect.y1 * previewH - offsetY) / scale;
      const rawW = ((rect.x2 - rect.x1) * previewW) / scale;
      const rawH = ((rect.y2 - rect.y1) * previewH) / scale;

      const originX = Math.max(0, Math.min(Math.round(rawX), photo.width - 1));
      const originY = Math.max(0, Math.min(Math.round(rawY), photo.height - 1));
      const width = Math.min(Math.round(rawW), photo.width - originX);
      const height = Math.min(Math.round(rawH), photo.height - originY);
      const croppedPhotoPath = await ImageUtils.crop(`file://${photo.path}`, {
        x: originX,
        y: originY,
        width,
        height,
      });

      setIsCameraActive(false);
      setReviewImage(croppedPhotoPath);
    } catch (error) {
      console.error('Capture error:', error);
    }
  }, [
    cameraLayout.height,
    cameraLayout.width,
    isCameraActive,
    isCameraInitialized,
    rect.x1,
    rect.x2,
    rect.y1,
    rect.y2,
    resizeMode,
  ]);

  const retake = useCallback(() => {
    setReviewImage(null);
    setIsCameraActive(true);
  }, []);

  if (hasPermission === false) {
    return (
      <View style={styles.container}>
        <Text style={styles.statusText}>Camera permission required</Text>
        <TouchableOpacity style={styles.retakeButton} onPress={requestPermission}>
          <Text style={styles.retakeText}>Grant Permission</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (!device) {
    return (
      <View style={styles.container}>
        <Text style={styles.statusText}>No camera device found</Text>
      </View>
    );
  }

  if (reviewImage) {
    return (
      <View style={styles.previewContainer}>
        <Image source={{ uri: reviewImage }} style={styles.previewImage} resizeMode="contain" />
        <TouchableOpacity style={styles.retakeButton} onPress={retake}>
          <Text style={styles.retakeText}>Capture Again</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View
      style={styles.container}
      onLayout={event => setCameraLayout(event.nativeEvent.layout)}
    >
      <Camera
        ref={cameraRef}
        photo
        isActive={isCameraActive}
        style={StyleSheet.absoluteFill}
        device={device}
        pixelFormat="yuv"
        format={format}
        resizeMode={resizeMode}
        outputOrientation="preview"
        onInitialized={() => setIsCameraInitialized(true)}
      />

      {overlayStyle ? <View style={[styles.overlay, overlayStyle]} /> : null}

      <View style={styles.captureContainer}>
        <TouchableOpacity style={styles.captureButton} onPress={grabImage} activeOpacity={0.7}>
          <View style={styles.captureButtonInner} />
        </TouchableOpacity>
        {isCameraActive ? null : (
          <ActivityIndicator size="small" color="#ffffff" style={styles.captureSpinner} />
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000000',
  },
  overlay: {
    position: 'absolute',
    borderWidth: 2,
    borderColor: '#FFD400',
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
  captureButtonInner: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: '#FFFFFF',
    borderWidth: 2,
    borderColor: '#CCCCCC',
  },
  captureSpinner: {
    marginTop: 12,
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
  statusText: {
    color: '#FFFFFF',
    textAlign: 'center',
    fontSize: 16,
  },
});
