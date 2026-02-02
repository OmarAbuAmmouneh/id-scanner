import * as ImageManipulator from 'expo-image-manipulator';
import * as MediaLibrary from 'expo-media-library';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Dimensions,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import type { Mat, MatVector } from 'react-native-fast-opencv';
import {
  ColorConversionCodes,
  ContourApproximationModes,
  DataTypes,
  ObjectType,
  OpenCV,
  RetrievalModes,
} from 'react-native-fast-opencv';
import RNFS from 'react-native-fs';
import {
  Camera,
  useCameraDevice,
  useCameraPermission,
  useFrameProcessor,
} from 'react-native-vision-camera';
import { useRunOnJS } from 'react-native-worklets-core';
import { useResizePlugin } from 'vision-camera-resize-plugin';

// ============================================================================
// CONSTANTS
// ============================================================================

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

// ID card aspect ratio (standard credit card size)
const FRAME_ASPECT_RATIO = 1.586;
const FRAME_WIDTH_PERCENT = 0.85;

// Minimum contour area to be considered a document (relative to frame size)
const MIN_AREA_THRESHOLD = 3000;

// ============================================================================
// TYPES
// ============================================================================

interface CaptureResult {
  filePath: string;
  base64: string;
}

interface IDScannerRealtimeProps {
  onCapture?: (result: CaptureResult) => void;
  saveToGallery?: boolean;
}

// ============================================================================
// MAIN COMPONENT
// ============================================================================

export default function IDScannerRealtime({
  onCapture,
  saveToGallery = true,
}: IDScannerRealtimeProps) {
  const cameraRef = useRef<Camera>(null);
  const { hasPermission, requestPermission } = useCameraPermission();
  const device = useCameraDevice('back');
  const { resize } = useResizePlugin();

  const [isCapturing, setIsCapturing] = useState(false);
  const [base64Data, setBase64Data] = useState<string | null>(null);
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const [documentDetected, setDocumentDetected] = useState(false);

  // Frame layout for UI overlay
  const frameWidth = SCREEN_WIDTH * FRAME_WIDTH_PERCENT;
  const frameHeight = frameWidth / FRAME_ASPECT_RATIO;
  const frameX = (SCREEN_WIDTH - frameWidth) / 2;
  const frameY = (SCREEN_HEIGHT - frameHeight) / 2;

  useEffect(() => {
    if (!hasPermission) {
      requestPermission();
    }
  }, [hasPermission, requestPermission]);

  // Callback to update detection status from worklet
  const updateDetectionStatus = useCallback((detected: boolean) => {
    setDocumentDetected(detected);
  }, []);

  // Create a worklet-callable version of the callback
  const runUpdateDetection = useRunOnJS(updateDetectionStatus, [updateDetectionStatus]);

  // ============================================================================
  // FRAME PROCESSOR - Real-time OpenCV detection
  // ============================================================================

  const frameProcessor = useFrameProcessor(
    (frame) => {
      'worklet';

      // Scale down for performance (1/4 size)
      const scaleFactor = 4;
      const height = Math.floor(frame.height / scaleFactor);
      const width = Math.floor(frame.width / scaleFactor);

      // Resize the frame for faster processing
      const resized = resize(frame, {
        scale: {
          width: width,
          height: height,
        },
        pixelFormat: 'bgr',
        dataType: 'uint8',
      });

      // Convert frame buffer to OpenCV Mat
      const src: Mat = OpenCV.frameBufferToMat(height, width, 3, resized);

      // Create output Mats
      const gray: Mat = OpenCV.createObject(
        ObjectType.Mat,
        height,
        width,
        DataTypes.CV_8U
      );
      const blurred: Mat = OpenCV.createObject(
        ObjectType.Mat,
        height,
        width,
        DataTypes.CV_8U
      );
      const edges: Mat = OpenCV.createObject(
        ObjectType.Mat,
        height,
        width,
        DataTypes.CV_8U
      );

      // Convert to grayscale
      OpenCV.invoke('cvtColor', src, gray, ColorConversionCodes.COLOR_BGR2GRAY);

      // Apply Gaussian blur to reduce noise
      const ksize = OpenCV.createObject(ObjectType.Size, 5, 5);
      OpenCV.invoke('GaussianBlur', gray, blurred, ksize, 0);

      // Apply Canny edge detection
      OpenCV.invoke('Canny', blurred, edges, 50, 150);

      // Find contours
      const contours: MatVector = OpenCV.createObject(ObjectType.MatVector);
      OpenCV.invoke(
        'findContours',
        edges,
        contours,
        RetrievalModes.RETR_EXTERNAL,
        ContourApproximationModes.CHAIN_APPROX_SIMPLE
      );

      // Get contours info
      const contoursInfo = OpenCV.toJSValue(contours);
      let foundQuadrilateral = false;

      // Find quadrilateral contours (potential documents)
      for (let i = 0; i < contoursInfo.array.length; i++) {
        const contour = OpenCV.copyObjectFromVector(contours, i);
        const { value: area } = OpenCV.invoke('contourArea', contour, false);

        // Filter by minimum area
        if (area > MIN_AREA_THRESHOLD) {
          // Get perimeter for polygon approximation
          const { value: perimeter } = OpenCV.invoke('arcLength', contour, true);

          // Approximate contour to polygon
          const approxCurve: Mat = OpenCV.createObject(
            ObjectType.Mat,
            0,
            0,
            DataTypes.CV_32S
          );
          OpenCV.invoke(
            'approxPolyDP',
            contour,
            approxCurve,
            0.02 * perimeter,
            true
          );

          // Get approximation info
          const approxInfo = OpenCV.toJSValue(approxCurve);

          // Check if it's a quadrilateral (4 vertices)
          if (approxInfo.rows === 4) {
            foundQuadrilateral = true;
            break;
          }
        }
      }

      // Update detection status on JS thread
      runUpdateDetection(foundQuadrilateral);

      // Clean up OpenCV buffers (CRITICAL for memory management)
      OpenCV.clearBuffers();
    },
    [resize, runUpdateDetection]
  );

  // ============================================================================
  // CAPTURE FUNCTION
  // ============================================================================

  const saveImageToGallery = useCallback(
    async (base64: string): Promise<string | null> => {
      const { status } = await MediaLibrary.requestPermissionsAsync(true);
      if (status !== 'granted') {
        Alert.alert('Permission Required', 'Please grant access to save photos.');
        return null;
      }

      const filename = `IDScan_Realtime_${Date.now()}.png`;

      try {
        const tempPath = `${RNFS.DocumentDirectoryPath}/${filename}`;
        await RNFS.writeFile(tempPath, base64, 'base64');
        const asset = await MediaLibrary.createAssetAsync(`file://${tempPath}`);
        await RNFS.unlink(tempPath).catch(() => {});
        return asset.uri;
      } catch (e) {
        console.error('Gallery save error:', e);
        return null;
      }
    },
    []
  );

  const capturePhoto = useCallback(async () => {
    if (!cameraRef.current || isCapturing) return;

    setIsCapturing(true);

    try {
      // Take photo
      const photo = await cameraRef.current.takePhoto({
        flash: 'off',
        enableShutterSound: true,
      });

      const photoPath = `file://${photo.path}`;

      // Calculate crop region for ID card area
      const cropWidth = Math.min(Math.round(photo.width * 0.9), photo.width);
      const cropHeight = Math.min(
        Math.round(cropWidth / FRAME_ASPECT_RATIO),
        photo.height - Math.round(photo.height * 0.2)
      );
      const originX = Math.round((photo.width - cropWidth) / 2);
      const originY = Math.round((photo.height - cropHeight) / 2);

      const croppedResult = await ImageManipulator.manipulateAsync(
        photoPath,
        [
          {
            crop: {
              originX: Math.max(0, originX),
              originY: Math.max(0, originY),
              width: cropWidth,
              height: cropHeight,
            },
          },
        ],
        {
          compress: 0.9,
          format: ImageManipulator.SaveFormat.PNG,
          base64: true,
        }
      );

      if (croppedResult.base64) {
        setBase64Data(croppedResult.base64);

        let galleryPath: string | null = null;
        if (saveToGallery) {
          galleryPath = await saveImageToGallery(croppedResult.base64);
          if (galleryPath) {
            setSavedPath(galleryPath);
          }
        }

        if (onCapture) {
          onCapture({
            filePath: croppedResult.uri,
            base64: croppedResult.base64,
          });
        }

        Alert.alert('Capture Complete', 'ID card image has been captured.', [
          { text: 'OK' },
        ]);
      }
    } catch (error) {
      console.error('Capture error:', error);
      Alert.alert('Error', 'Failed to capture. Please try again.');
    } finally {
      setIsCapturing(false);
    }
  }, [isCapturing, saveToGallery, saveImageToGallery, onCapture]);

  // ============================================================================
  // RENDER
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
    <View style={styles.container}>
      {/* Camera Preview with Frame Processor */}
      <Camera
        ref={cameraRef}
        style={StyleSheet.absoluteFill}
        device={device}
        isActive={true}
        photo={true}
        frameProcessor={frameProcessor}
      />

      {/* Frame Overlay */}
      <View
        style={[styles.overlay, { top: 0, left: 0, right: 0, height: frameY }]}
      />
      <View
        style={[
          styles.overlay,
          { top: frameY + frameHeight, left: 0, right: 0, bottom: 0 },
        ]}
      />
      <View
        style={[
          styles.overlay,
          { top: frameY, left: 0, width: frameX, height: frameHeight },
        ]}
      />
      <View
        style={[
          styles.overlay,
          { top: frameY, right: 0, width: frameX, height: frameHeight },
        ]}
      />

      {/* Frame Border - changes color based on detection */}
      <View
        style={[
          styles.frame,
          {
            top: frameY,
            left: frameX,
            width: frameWidth,
            height: frameHeight,
            borderColor: documentDetected ? '#00FF00' : '#FFFFFF',
          },
        ]}
      >
        <View style={[styles.corner, styles.cornerTopLeft, documentDetected && styles.cornerDetected]} />
        <View style={[styles.corner, styles.cornerTopRight, documentDetected && styles.cornerDetected]} />
        <View style={[styles.corner, styles.cornerBottomLeft, documentDetected && styles.cornerDetected]} />
        <View style={[styles.corner, styles.cornerBottomRight, documentDetected && styles.cornerDetected]} />
      </View>

      {/* Detection indicator overlay */}
      {documentDetected && (
        <View
          style={[
            styles.detectionOverlay,
            {
              top: frameY,
              left: frameX,
              width: frameWidth,
              height: frameHeight,
            },
          ]}
        />
      )}

      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.title}>Real-time Scanner</Text>
        <Text style={styles.subtitle}>OpenCV Edge Detection</Text>
      </View>

      {/* Status */}
      <View style={styles.statusContainer}>
        <Text style={[styles.detectionStatus, documentDetected && styles.detectionStatusActive]}>
          {documentDetected
            ? 'Document detected!'
            : 'Position ID card within frame'}
        </Text>
      </View>

      {/* Capture Button */}
      <View style={styles.captureContainer}>
        <TouchableOpacity
          style={[
            styles.captureButton,
            isCapturing && styles.captureButtonDisabled,
            documentDetected && styles.captureButtonActive,
          ]}
          onPress={capturePhoto}
          disabled={isCapturing}
          activeOpacity={0.7}
        >
          {isCapturing ? (
            <ActivityIndicator size="small" color="#000000" />
          ) : (
            <View style={[styles.captureButtonInner, documentDetected && styles.captureButtonInnerActive]} />
          )}
        </TouchableOpacity>
        <Text style={styles.captureHint}>
          {documentDetected ? 'Document ready - Tap to capture' : 'Tap to capture'}
        </Text>
      </View>

      {/* Result Info */}
      {base64Data && (
        <View style={styles.resultInfo}>
          <Text style={styles.resultText}>
            Captured ({Math.round(base64Data.length / 1024)}KB)
          </Text>
          {savedPath && (
            <Text style={styles.resultText} numberOfLines={1}>
              Saved: {savedPath.split('/').pop()}
            </Text>
          )}
        </View>
      )}
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
    borderRadius: 12,
  },
  detectionOverlay: {
    position: 'absolute',
    backgroundColor: 'rgba(0, 255, 0, 0.1)',
    borderRadius: 12,
  },
  corner: {
    position: 'absolute',
    width: 24,
    height: 24,
    borderColor: '#FFFFFF',
    borderWidth: 3,
  },
  cornerDetected: {
    borderColor: '#00FF00',
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
    color: '#00FF00',
    fontSize: 24,
    fontWeight: 'bold',
  },
  subtitle: {
    color: 'rgba(0, 255, 0, 0.6)',
    fontSize: 14,
    marginTop: 4,
  },
  statusContainer: {
    position: 'absolute',
    top: 120,
    left: 20,
    right: 20,
    alignItems: 'center',
  },
  detectionStatus: {
    color: '#ffffff',
    fontSize: 16,
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
    overflow: 'hidden',
  },
  detectionStatusActive: {
    backgroundColor: 'rgba(0, 128, 0, 0.9)',
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
  captureButtonActive: {
    backgroundColor: '#00FF00',
    borderColor: 'rgba(0, 255, 0, 0.5)',
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
  captureButtonInnerActive: {
    backgroundColor: '#00FF00',
    borderColor: '#00CC00',
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
  resultInfo: {
    position: 'absolute',
    bottom: 160,
    left: 20,
    right: 20,
    backgroundColor: 'rgba(0, 128, 0, 0.9)',
    padding: 12,
    borderRadius: 8,
  },
  resultText: {
    color: '#ffffff',
    fontSize: 14,
    textAlign: 'center',
  },
});
