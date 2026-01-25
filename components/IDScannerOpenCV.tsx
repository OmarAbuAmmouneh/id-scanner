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
  View
} from 'react-native';
import { OpenCV } from 'react-native-fast-opencv';
import RNFS from 'react-native-fs';
import {
  Camera,
  PhotoFile,
  useCameraDevice,
  useCameraPermission,
} from 'react-native-vision-camera';

// ============================================================================
// CONSTANTS
// ============================================================================

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

// ID card aspect ratio
const FRAME_ASPECT_RATIO = 1.586;
const FRAME_WIDTH_PERCENT = 0.85;

// ============================================================================
// TYPES
// ============================================================================

interface CaptureResult {
  filePath: string;
  base64: string;
}

interface IDScannerOpenCVProps {
  onCapture?: (result: CaptureResult) => void;
  saveToGallery?: boolean;
}

// ============================================================================
// OPENCV DOCUMENT DETECTION
// ============================================================================

async function detectDocumentEdges(imagePath: string): Promise<{
  hasDocument: boolean;
  corners?: { x: number; y: number }[];
  processedImagePath?: string;
}> {
  try {
    // Load the image
    const source = await OpenCV.importFromUrl(imagePath);
    
    // Convert to grayscale
    const gray = await OpenCV.invoke('cvtColor', source, OpenCV.ColorConversions.COLOR_BGR2GRAY);
    
    // Apply Gaussian blur to reduce noise
    const blurred = await OpenCV.invoke('GaussianBlur', gray, { width: 5, height: 5 }, 0);
    
    // Apply Canny edge detection
    const edges = await OpenCV.invoke('Canny', blurred, 75, 200);
    
    // Find contours
    const contours = await OpenCV.invoke('findContours', edges, OpenCV.RetrievalModes.RETR_LIST, OpenCV.ContourApproximationModes.CHAIN_APPROX_SIMPLE);
    
    // Sort contours by area (largest first)
    let largestContour = null;
    let maxArea = 0;
    
    for (const contour of contours) {
      const area = await OpenCV.invoke('contourArea', contour);
      if (area > maxArea) {
        maxArea = area;
        largestContour = contour;
      }
    }
    
    if (largestContour) {
      // Approximate the contour to a polygon
      const perimeter = await OpenCV.invoke('arcLength', largestContour, true);
      const approx = await OpenCV.invoke('approxPolyDP', largestContour, 0.02 * perimeter, true);
      
      // Check if it's a quadrilateral (4 corners)
      const points = await OpenCV.getContourPoints(approx);
      
      if (points.length === 4) {
        console.log('=== OpenCV Document Detection ===');
        console.log('Document detected with 4 corners');
        console.log('Corners:', points);
        
        return {
          hasDocument: true,
          corners: points,
        };
      }
    }
    
    console.log('No document detected');
    return { hasDocument: false };
  } catch (error) {
    console.error('OpenCV detection error:', error);
    return { hasDocument: false };
  }
}

// ============================================================================
// MAIN COMPONENT
// ============================================================================

export default function IDScannerOpenCV({
  onCapture,
  saveToGallery = true,
}: IDScannerOpenCVProps) {
  const cameraRef = useRef<Camera>(null);
  const { hasPermission, requestPermission } = useCameraPermission();
  const device = useCameraDevice('back');

  const [isCapturing, setIsCapturing] = useState(false);
  const [base64Data, setBase64Data] = useState<string | null>(null);
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const [detectionStatus, setDetectionStatus] = useState<string>('Ready to scan');

  // Frame layout
  const frameWidth = SCREEN_WIDTH * FRAME_WIDTH_PERCENT;
  const frameHeight = frameWidth / FRAME_ASPECT_RATIO;
  const frameX = (SCREEN_WIDTH - frameWidth) / 2;
  const frameY = (SCREEN_HEIGHT - frameHeight) / 2;

  useEffect(() => {
    if (!hasPermission) {
      requestPermission();
    }
  }, [hasPermission, requestPermission]);

  // Save to gallery
  const saveImageToGallery = useCallback(async (base64: string): Promise<string | null> => {
    const { status } = await MediaLibrary.requestPermissionsAsync(true);
    if (status !== 'granted') {
      Alert.alert('Permission Required', 'Please grant access to save photos.');
      return null;
    }

    const filename = `IDScan_OpenCV_${Date.now()}.png`;

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
  }, []);

  // Capture and process with OpenCV
  const captureAndProcess = useCallback(async () => {
    if (!cameraRef.current || isCapturing) return;

    setIsCapturing(true);
    setDetectionStatus('Capturing...');

    try {
      // Take photo
      const photo: PhotoFile = await cameraRef.current.takePhoto({
        flash: 'off',
        enableShutterSound: true,
      });

      const photoPath = `file://${photo.path}`;
      setDetectionStatus('Detecting document edges...');

      // Detect document with OpenCV
      const detection = await detectDocumentEdges(photoPath);

      if (detection.hasDocument && detection.corners) {
        setDetectionStatus('Document detected! Processing...');
        console.log('Document corners:', detection.corners);
      } else {
        setDetectionStatus('No document edges detected, using full image');
      }

      // Calculate safe crop region that fits within image bounds
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

        setDetectionStatus('Capture complete!');
        Alert.alert(
          'OpenCV Scan Complete',
          detection.hasDocument
            ? 'Document edges detected and captured.'
            : 'Image captured (no edges detected).',
          [{ text: 'OK' }]
        );
      }
    } catch (error) {
      console.error('Capture error:', error);
      setDetectionStatus('Error capturing');
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
      {/* Camera Preview */}
      <Camera
        ref={cameraRef}
        style={StyleSheet.absoluteFill}
        device={device}
        isActive={true}
        photo={true}
      />

      {/* Frame Overlay */}
      <View style={[styles.overlay, { top: 0, left: 0, right: 0, height: frameY }]} />
      <View style={[styles.overlay, { top: frameY + frameHeight, left: 0, right: 0, bottom: 0 }]} />
      <View style={[styles.overlay, { top: frameY, left: 0, width: frameX, height: frameHeight }]} />
      <View style={[styles.overlay, { top: frameY, right: 0, width: frameX, height: frameHeight }]} />

      {/* Frame Border */}
      <View
        style={[
          styles.frame,
          {
            top: frameY,
            left: frameX,
            width: frameWidth,
            height: frameHeight,
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
        <Text style={styles.title}>OpenCV Scanner</Text>
        <Text style={styles.subtitle}>(Experimental)</Text>
      </View>

      {/* Status */}
      <View style={styles.statusContainer}>
        <Text style={styles.detectionStatus}>{detectionStatus}</Text>
      </View>

      {/* Capture Button */}
      <View style={styles.captureContainer}>
        <TouchableOpacity
          style={[styles.captureButton, isCapturing && styles.captureButtonDisabled]}
          onPress={captureAndProcess}
          disabled={isCapturing}
          activeOpacity={0.7}
        >
          {isCapturing ? (
            <ActivityIndicator size="small" color="#000000" />
          ) : (
            <View style={styles.captureButtonInner} />
          )}
        </TouchableOpacity>
        <Text style={styles.captureHint}>Tap to capture with OpenCV</Text>
      </View>

      {/* Result Info */}
      {base64Data && (
        <View style={styles.resultInfo}>
          <Text style={styles.resultText}>
            ✓ Captured ({Math.round(base64Data.length / 1024)}KB)
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
    borderColor: '#00FF00', // Green for OpenCV theme
    borderRadius: 12,
  },
  corner: {
    position: 'absolute',
    width: 24,
    height: 24,
    borderColor: '#00FF00',
    borderWidth: 3,
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
  captureContainer: {
    position: 'absolute',
    bottom: 60,
    alignItems: 'center',
  },
  captureButton: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: '#00FF00',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 4,
    borderColor: 'rgba(0, 255, 0, 0.5)',
  },
  captureButtonDisabled: {
    opacity: 0.5,
  },
  captureButtonInner: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: '#00FF00',
    borderWidth: 2,
    borderColor: '#00CC00',
  },
  captureHint: {
    color: '#00FF00',
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
