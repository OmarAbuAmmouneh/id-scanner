import * as ImageManipulator from 'expo-image-manipulator';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Dimensions,
  Image,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  useWindowDimensions,
} from 'react-native';
import {
  Camera,
  useCameraDevice,
  useCameraPermission,
} from 'react-native-vision-camera';

// ============================================================================
// CONSTANTS
// ============================================================================

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

// ID card aspect ratio (standard credit card size: 85.6mm x 53.98mm)
const FRAME_ASPECT_RATIO = 1.586;
const FRAME_WIDTH_PERCENT = 0.85;

// ============================================================================
// TYPES
// ============================================================================

interface IDScannerSimpleProps {
  onCapture?: (photoUri: string) => void;
}

// ============================================================================
// CROP MATH UTILITY
// ============================================================================

function calculateCropRegion(
  photoWidth: number,
  photoHeight: number,
  previewWidth: number,
  previewHeight: number,
  frameX: number,
  frameY: number,
  frameWidth: number,
  frameHeight: number
): ImageManipulator.ActionCrop['crop'] {
  const screenAspect = previewWidth / previewHeight;
  const photoAspect = photoWidth / photoHeight;

  let scaleX: number;
  let scaleY: number;
  let offsetX = 0;
  let offsetY = 0;

  if (photoAspect > screenAspect) {
    scaleY = photoHeight / previewHeight;
    scaleX = scaleY;
    const visiblePhotoWidth = previewWidth * scaleX;
    offsetX = (photoWidth - visiblePhotoWidth) / 2;
  } else {
    scaleX = photoWidth / previewWidth;
    scaleY = scaleX;
    const visiblePhotoHeight = previewHeight * scaleY;
    offsetY = (photoHeight - visiblePhotoHeight) / 2;
  }

  const cropX = offsetX + frameX * scaleX;
  const cropY = offsetY + frameY * scaleY;
  const cropWidth = frameWidth * scaleX;
  const cropHeight = frameHeight * scaleY;

  return {
    originX: Math.max(0, Math.round(cropX)),
    originY: Math.max(0, Math.round(cropY)),
    width: Math.min(photoWidth - cropX, Math.round(cropWidth)),
    height: Math.min(photoHeight - cropY, Math.round(cropHeight)),
  };
}

// ============================================================================
// MAIN COMPONENT
// ============================================================================

export default function IDScannerSimple({ onCapture }: IDScannerSimpleProps) {
  const windowDimensions = useWindowDimensions();
  const cameraRef = useRef<Camera>(null);
  const { hasPermission, requestPermission } = useCameraPermission();
  const device = useCameraDevice('back');

  const [isCapturing, setIsCapturing] = useState(false);
  const [capturedPhoto, setCapturedPhoto] = useState<string | null>(null);
  const [previewSize, setPreviewSize] = useState({
    width: windowDimensions.width || SCREEN_WIDTH,
    height: windowDimensions.height || SCREEN_HEIGHT,
  });

  // Frame layout for UI overlay (based on measured preview size)
  const frameLayout = useMemo(() => {
    const frameWidth = previewSize.width * FRAME_WIDTH_PERCENT;
    const frameHeight = frameWidth / FRAME_ASPECT_RATIO;
    const frameX = (previewSize.width - frameWidth) / 2;
    const frameY = (previewSize.height - frameHeight) / 2;
    return { frameWidth, frameHeight, frameX, frameY };
  }, [previewSize.height, previewSize.width]);

  const handlePreviewLayout = useCallback((event: any) => {
    const { width, height } = event.nativeEvent.layout;
    if (!width || !height) return;
    if (width !== previewSize.width || height !== previewSize.height) {
      setPreviewSize({ width, height });
    }
  }, [previewSize.height, previewSize.width]);

  useEffect(() => {
    if (!hasPermission) {
      requestPermission();
    }
  }, [hasPermission, requestPermission]);

  // ============================================================================
  // CAPTURE FUNCTION - with cover-mode aware cropping
  // ============================================================================

  const capturePhoto = useCallback(async () => {
    if (!cameraRef.current || isCapturing) return;

    setIsCapturing(true);

    try {
      const photo = await cameraRef.current.takePhoto({
        flash: 'off',
        enableShutterSound: true,
      });

      let photoPath = `file://${photo.path}`;
      let effectiveWidth = photo.width;
      let effectiveHeight = photo.height;

      const rotationByOrientation: Record<string, number> = {
        portrait: 0,
        'portrait-upside-down': 180,
        'landscape-left': 90,
        'landscape-right': 270,
      };
      const rotation = rotationByOrientation[photo.orientation] ?? 0;
      if (rotation !== 0) {
        const rotated = await ImageManipulator.manipulateAsync(
          photoPath,
          [{ rotate: rotation }],
          { compress: 1, format: ImageManipulator.SaveFormat.PNG }
        );
        photoPath = rotated.uri;
        if (rotated.width && rotated.height) {
          effectiveWidth = rotated.width;
          effectiveHeight = rotated.height;
        } else {
          effectiveWidth = rotation % 180 === 0 ? photo.width : photo.height;
          effectiveHeight = rotation % 180 === 0 ? photo.height : photo.width;
        }
      }

      const cropRegion = calculateCropRegion(
        effectiveWidth,
        effectiveHeight,
        previewSize.width,
        previewSize.height,
        frameLayout.frameX,
        frameLayout.frameY,
        frameLayout.frameWidth,
        frameLayout.frameHeight
      );

      // Crop the photo to match the frame overlay
      const croppedResult = await ImageManipulator.manipulateAsync(
        photoPath,
        [{ crop: cropRegion }],
        { compress: 0.9, format: ImageManipulator.SaveFormat.PNG }
      );

      setCapturedPhoto(croppedResult.uri);

      if (onCapture) {
        onCapture(croppedResult.uri);
      }
    } catch (error) {
      console.error('Capture error:', error);
    } finally {
      setIsCapturing(false);
    }
  }, [frameLayout, isCapturing, onCapture, previewSize.height, previewSize.width]);

  // Go back to camera mode
  const captureAgain = useCallback(() => {
    setCapturedPhoto(null);
  }, []);

  // ============================================================================
  // RENDER - Photo Preview
  // ============================================================================

  if (capturedPhoto) {
    return (
      <View style={styles.container}>
        <Image
          source={{ uri: capturedPhoto }}
          style={styles.previewImage}
          resizeMode="contain"
        />
        
        <View style={styles.previewHeader}>
          <Text style={styles.previewTitle}>Captured Photo</Text>
        </View>

        <View style={styles.previewButtonContainer}>
          <TouchableOpacity
            style={styles.captureAgainButton}
            onPress={captureAgain}
            activeOpacity={0.7}
          >
            <Text style={styles.captureAgainText}>Capture Again</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  // ============================================================================
  // RENDER - Camera
  // ============================================================================

  if (hasPermission === null) {
    return (
      <View style={styles.container}>
        <ActivityIndicator size="large" color="#ffffff" />
        <Text style={styles.statusText}>Checking camera permission...</Text>
      </View>
    );
  }

  if (!hasPermission) {
    return (
      <View style={styles.container}>
        <Text style={styles.statusText}>Camera permission required</Text>
        <TouchableOpacity style={styles.button} onPress={requestPermission}>
          <Text style={styles.buttonText}>Grant Permission</Text>
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

  return (
    <View style={styles.container} onLayout={handlePreviewLayout}>
      {/* Camera Preview */}
      <Camera
        ref={cameraRef}
        style={StyleSheet.absoluteFill}
        device={device}
        isActive={true}
        photo={true}
      />

      {/* Dark Overlay - Top */}
      <View
        style={[
          styles.overlay,
          { top: 0, left: 0, right: 0, height: frameLayout.frameY },
        ]}
      />
      {/* Dark Overlay - Bottom */}
      <View
        style={[
          styles.overlay,
          {
            top: frameLayout.frameY + frameLayout.frameHeight,
            left: 0,
            right: 0,
            bottom: 0,
          },
        ]}
      />
      {/* Dark Overlay - Left */}
      <View
        style={[
          styles.overlay,
          {
            top: frameLayout.frameY,
            left: 0,
            width: frameLayout.frameX,
            height: frameLayout.frameHeight,
          },
        ]}
      />
      {/* Dark Overlay - Right */}
      <View
        style={[
          styles.overlay,
          {
            top: frameLayout.frameY,
            right: 0,
            width: frameLayout.frameX,
            height: frameLayout.frameHeight,
          },
        ]}
      />

      {/* Frame Border with Corner Markers */}
      <View
        style={[
          styles.frame,
          {
            top: frameLayout.frameY,
            left: frameLayout.frameX,
            width: frameLayout.frameWidth,
            height: frameLayout.frameHeight,
          },
        ]}
      >
        <View style={[styles.corner, styles.cornerTopLeft]} />
        <View style={[styles.corner, styles.cornerTopRight]} />
        <View style={[styles.corner, styles.cornerBottomLeft]} />
        <View style={[styles.corner, styles.cornerBottomRight]} />
      </View>

      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.title}>ID Scanner</Text>
        <Text style={styles.subtitle}>Position your ID card within the frame</Text>
      </View>

      {/* Capture Button */}
      <View style={styles.captureContainer}>
        <TouchableOpacity
          style={[
            styles.captureButton,
            isCapturing && styles.captureButtonDisabled,
          ]}
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
        <Text style={styles.captureHint}>Tap to capture</Text>
      </View>
    </View>
  );
}

// ============================================================================
// STYLES
// ============================================================================

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000000',
    justifyContent: 'center',
    alignItems: 'center',
  },
  overlay: {
    position: 'absolute',
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
  },
  frame: {
    position: 'absolute',
    borderWidth: 2,
    borderColor: '#FFFFFF',
    borderRadius: 12,
  },
  corner: {
    position: 'absolute',
    width: 28,
    height: 28,
    borderColor: '#00FF00',
    borderWidth: 4,
  },
  cornerTopLeft: {
    top: -2,
    left: -2,
    borderRightWidth: 0,
    borderBottomWidth: 0,
    borderTopLeftRadius: 12,
  },
  cornerTopRight: {
    top: -2,
    right: -2,
    borderLeftWidth: 0,
    borderBottomWidth: 0,
    borderTopRightRadius: 12,
  },
  cornerBottomLeft: {
    bottom: -2,
    left: -2,
    borderRightWidth: 0,
    borderTopWidth: 0,
    borderBottomLeftRadius: 12,
  },
  cornerBottomRight: {
    bottom: -2,
    right: -2,
    borderLeftWidth: 0,
    borderTopWidth: 0,
    borderBottomRightRadius: 12,
  },
  header: {
    position: 'absolute',
    top: 60,
    alignItems: 'center',
  },
  title: {
    color: '#FFFFFF',
    fontSize: 28,
    fontWeight: 'bold',
  },
  subtitle: {
    color: 'rgba(255, 255, 255, 0.7)',
    fontSize: 14,
    marginTop: 6,
  },
  captureContainer: {
    position: 'absolute',
    bottom: 60,
    alignItems: 'center',
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
  captureHint: {
    color: '#FFFFFF',
    fontSize: 14,
    marginTop: 12,
  },
  statusText: {
    color: '#ffffff',
    fontSize: 16,
    textAlign: 'center',
    marginBottom: 20,
  },
  button: {
    backgroundColor: '#00FF00',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 8,
  },
  buttonText: {
    color: '#000000',
    fontSize: 16,
    fontWeight: '600',
  },
  // Preview styles
  previewImage: {
    flex: 1,
    width: '100%',
    height: '100%',
  },
  previewHeader: {
    position: 'absolute',
    top: 60,
    alignItems: 'center',
  },
  previewTitle: {
    color: '#FFFFFF',
    fontSize: 24,
    fontWeight: 'bold',
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 8,
    overflow: 'hidden',
  },
  previewButtonContainer: {
    position: 'absolute',
    bottom: 60,
    alignItems: 'center',
  },
  captureAgainButton: {
    backgroundColor: '#FFFFFF',
    paddingHorizontal: 32,
    paddingVertical: 16,
    borderRadius: 30,
  },
  captureAgainText: {
    color: '#000000',
    fontSize: 18,
    fontWeight: '600',
  },
});
