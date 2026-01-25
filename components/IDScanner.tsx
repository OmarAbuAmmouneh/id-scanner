import TextRecognition from '@react-native-ml-kit/text-recognition';
import * as ImageManipulator from 'expo-image-manipulator';
import * as MediaLibrary from 'expo-media-library';
import { parse as parseMRZ } from 'mrz';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Dimensions,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  useWindowDimensions,
} from 'react-native';
import DocumentScanner from 'react-native-document-scanner-plugin';
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

// ID card standard aspect ratio (width / height)
const FRAME_ASPECT_RATIO = 1.586;

// Frame width as percentage of screen width
const FRAME_WIDTH_PERCENT = 0.85;

// Get screen dimensions (fallback before layout is measured)
const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

// Overlay opacity for darkened areas
const OVERLAY_OPACITY = 0.6;

// ============================================================================
// TYPES
// ============================================================================

interface CaptureResult {
  filePath: string;
  base64: string;
  /** Whether native scanner was used (with auto-detection) */
  nativeScanner?: boolean;
}

interface IDScannerProps {
  /** Callback when photo is captured */
  onCapture?: (result: CaptureResult) => void;
  /** Custom frame aspect ratio (default: 1.586 for ID cards) */
  frameAspectRatio?: number;
  /** Use native document scanner with auto-detection (default: true) */
  useNativeScanner?: boolean;
  /** Save captured image to gallery (default: true) */
  saveToGallery?: boolean;
}

// ============================================================================
// CROP MATH UTILITY (for manual capture mode)
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
// MRZ DETECTION UTILITY
// ============================================================================

// Regex to detect MRZ patterns (2-3 lines of uppercase + digits + < characters)
const MRZ_LINE_PATTERN = /^[A-Z0-9<]{30,44}$/;

function detectMRZLines(text: string): string[] | null {
  const lines = text
    .split('\n')
    .map(line => line.trim().toUpperCase().replace(/\s/g, ''))
    .filter(line => MRZ_LINE_PATTERN.test(line));

  // MRZ has 2 lines (passport/TD2) or 3 lines (TD1 ID cards)
  if (lines.length >= 2) {
    return lines.slice(0, lines.length >= 3 ? 3 : 2);
  }
  return null;
}

// ============================================================================
// OCR UTILITY
// ============================================================================

async function extractTextFromImage(imagePath: string): Promise<void> {
  try {
    const result = await TextRecognition.recognize(imagePath);
    const ocrText = result.text;

    console.log('=== OCR Results ===');
    console.log('Raw text:', ocrText);

    // Check for MRZ and parse if found
    const mrzLines = detectMRZLines(ocrText);
    if (mrzLines) {
      try {
        const mrzString = mrzLines.join('\n');
        const parsed = parseMRZ(mrzString);
        const fields = parsed.fields as Record<string, string | null>;
        console.log('=== MRZ Detected ===');
        console.log('Document Type:', fields.documentType);
        console.log('Country:', fields.issuingState);
        console.log('Last Name:', fields.lastName);
        console.log('First Name:', fields.firstName);
        console.log('Document Number:', fields.documentNumber);
        console.log('Nationality:', fields.nationality);
        console.log('Date of Birth:', fields.birthDate);
        console.log('Sex:', fields.sex);
        console.log('Expiration Date:', fields.expirationDate);
        console.log('Valid:', parsed.valid);
      } catch (mrzError) {
        console.log('MRZ pattern found but parsing failed:', mrzError);
      }
    } else {
      console.log('No MRZ detected in image');
    }
  } catch (error) {
    console.error('OCR Error:', error);
  }
}

// ============================================================================
// MAIN COMPONENT
// ============================================================================

export default function IDScanner({
  onCapture,
  frameAspectRatio = FRAME_ASPECT_RATIO,
  useNativeScanner = true,
  saveToGallery = true,
}: IDScannerProps) {
  const windowDimensions = useWindowDimensions();
  const cameraRef = useRef<Camera>(null);
  const { hasPermission, requestPermission } = useCameraPermission();
  const device = useCameraDevice('back');

  // State
  const [base64Data, setBase64Data] = useState<string | null>(null);
  const [isCapturing, setIsCapturing] = useState(false);
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const [previewSize, setPreviewSize] = useState({
    width: windowDimensions.width || SCREEN_WIDTH,
    height: windowDimensions.height || SCREEN_HEIGHT,
  });

  // Frame layout calculations (for manual mode)
  const frameLayout = useMemo(() => {
    const frameWidth = previewSize.width * FRAME_WIDTH_PERCENT;
    const frameHeight = frameWidth / frameAspectRatio;
    const frameX = (previewSize.width - frameWidth) / 2;
    const frameY = (previewSize.height - frameHeight) / 2;
    return { frameWidth, frameHeight, frameX, frameY };
  }, [previewSize.height, previewSize.width, frameAspectRatio]);

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
  // SAVE TO GALLERY
  // ============================================================================

  const saveImageToGallery = useCallback(async (base64: string): Promise<string | null> => {
    const { status } = await MediaLibrary.requestPermissionsAsync(true);
    if (status !== 'granted') {
      console.log('Media library permission denied');
      Alert.alert(
        'Permission Required',
        'Please grant access to save photos to your gallery.',
        [{ text: 'OK' }]
      );
      return null;
    }

    const filename = `IDScan_${Date.now()}.png`;

    try {
      const tempPath = `${RNFS.ExternalDirectoryPath || RNFS.DocumentDirectoryPath}/${filename}`;
      await RNFS.writeFile(tempPath, base64, 'base64');

      const asset = await MediaLibrary.createAssetAsync(`file://${tempPath}`);
      await RNFS.unlink(tempPath).catch(() => {});
      
      return asset.uri;
    } catch (e: any) {
      console.log('Gallery save error:', e);
      return null;
    }
  }, []);

  // ============================================================================
  // NATIVE DOCUMENT SCANNER
  // ============================================================================

  const launchNativeScanner = useCallback(async () => {
    if (isCapturing) return;

    setIsCapturing(true);

    try {
      // Launch the native document scanner
      // This uses VisionKit on iOS and ML Kit on Android
      const result = await DocumentScanner.scanDocument({
        maxNumDocuments: 1,
        croppedImageQuality: 100,
      });

      if (result.scannedImages && result.scannedImages.length > 0) {
        const scannedImagePath = result.scannedImages[0];
        
        // Read the image as base64
        const base64 = await RNFS.readFile(scannedImagePath, 'base64');

        // Run OCR on the scanned image
        await extractTextFromImage(scannedImagePath);
        
        setBase64Data(base64);

        // Save to gallery if enabled
        let galleryPath: string | null = null;
        if (saveToGallery) {
          galleryPath = await saveImageToGallery(base64);
          if (galleryPath) {
            setSavedPath(galleryPath);
          }
        }

        // Call onCapture callback
        if (onCapture) {
          onCapture({
            filePath: scannedImagePath,
            base64,
            nativeScanner: true,
          });
        }

        Alert.alert(
          'Scan Complete',
          saveToGallery && galleryPath
            ? 'Document scanned and saved to Gallery.'
            : 'Document scanned successfully.',
          [{ text: 'OK' }]
        );
      }
    } catch (error: any) {
      // User cancelled or error occurred
      if (error?.message?.includes('cancel')) {
        console.log('User cancelled document scan');
      } else {
        console.error('Document scan error:', error);
        Alert.alert('Error', 'Failed to scan document. Please try again.');
      }
    } finally {
      setIsCapturing(false);
    }
  }, [isCapturing, saveToGallery, saveImageToGallery, onCapture]);

  // ============================================================================
  // MANUAL CAPTURE (fallback mode)
  // ============================================================================

  const capturePhotoManually = useCallback(async () => {
    if (!cameraRef.current || isCapturing) return;

    setIsCapturing(true);

    try {
      const photo: PhotoFile = await cameraRef.current.takePhoto({
        flash: 'off',
        enableShutterSound: true,
      });

      const photoPath = `file://${photo.path}`;

      const cropRegion = calculateCropRegion(
        photo.width,
        photo.height,
        previewSize.width,
        previewSize.height,
        frameLayout.frameX,
        frameLayout.frameY,
        frameLayout.frameWidth,
        frameLayout.frameHeight
      );

      const croppedResult = await ImageManipulator.manipulateAsync(
        photoPath,
        [{ crop: cropRegion }],
        {
          compress: 0.9,
          format: ImageManipulator.SaveFormat.PNG,
          base64: true,
        }
      );

      if (croppedResult.base64) {
        // Run OCR on the cropped image
        await extractTextFromImage(croppedResult.uri);

        setBase64Data(croppedResult.base64);

        // Save to gallery if enabled
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
            nativeScanner: false,
          });
        }

        Alert.alert(
          'Capture Complete',
          saveToGallery && galleryPath
            ? 'Image captured and saved to Gallery.'
            : 'Image captured successfully.',
          [{ text: 'OK' }]
        );
      }
    } catch (error) {
      console.error('Error capturing photo:', error);
      Alert.alert('Error', 'Failed to capture photo. Please try again.');
    } finally {
      setIsCapturing(false);
    }
  }, [isCapturing, frameLayout, previewSize, saveToGallery, saveImageToGallery, onCapture]);

  // ============================================================================
  // RENDER - Permission States
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
        <Text style={styles.statusText}>Camera permission is required</Text>
        <TouchableOpacity style={styles.permissionButton} onPress={requestPermission}>
          <Text style={styles.permissionButtonText}>Grant Permission</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // ============================================================================
  // RENDER - Native Scanner Mode
  // ============================================================================

  if (useNativeScanner) {
    return (
      <View style={styles.container}>
        {/* Background camera preview (decorative) */}
        {device && (
          <Camera
            style={StyleSheet.absoluteFill}
            device={device}
            isActive={true}
            photo={false}
          />
        )}

        {/* Overlay */}
        <View style={styles.nativeScannerOverlay}>
          <View style={styles.nativeScannerContent}>
            <Text style={styles.nativeScannerTitle}>ID Document Scanner</Text>
            <Text style={styles.nativeScannerDescription}>
              Tap the button below to open the document scanner.{'\n'}
              The scanner will automatically detect and capture your ID.
            </Text>

            <TouchableOpacity
              style={[styles.scanButton, isCapturing && styles.scanButtonDisabled]}
              onPress={launchNativeScanner}
              disabled={isCapturing}
              activeOpacity={0.7}
            >
              {isCapturing ? (
                <ActivityIndicator size="large" color="#ffffff" />
              ) : (
                <>
                  <Text style={styles.scanButtonIcon}>📷</Text>
                  <Text style={styles.scanButtonText}>Scan Document</Text>
                </>
              )}
            </TouchableOpacity>

            <Text style={styles.nativeScannerHint}>
              Auto-detection • Edge correction • High quality
            </Text>
          </View>

          {/* Show captured result */}
          {base64Data && (
            <View style={styles.resultBadge}>
              <Text style={styles.resultText}>
                ✓ Scanned ({Math.round(base64Data.length / 1024)}KB)
              </Text>
              {savedPath && (
                <Text style={styles.resultText} numberOfLines={1}>
                  Saved: {savedPath.split('/').pop()}
                </Text>
              )}
            </View>
          )}
        </View>
      </View>
    );
  }

  // ============================================================================
  // RENDER - Manual Capture Mode (with frame overlay)
  // ============================================================================

  if (!device) {
    return (
      <View style={styles.container}>
        <Text style={styles.statusText}>No camera device found</Text>
      </View>
    );
  }

  return (
    <View style={styles.container} onLayout={handlePreviewLayout}>
      {/* Full-screen camera preview */}
      <Camera
        ref={cameraRef}
        style={StyleSheet.absoluteFill}
        device={device}
        isActive={true}
        photo={true}
      />

      {/* Overlays */}
      <View style={[styles.overlay, { top: 0, left: 0, right: 0, height: frameLayout.frameY }]} />
      <View style={[styles.overlay, { top: frameLayout.frameY + frameLayout.frameHeight, left: 0, right: 0, bottom: 0 }]} />
      <View style={[styles.overlay, { top: frameLayout.frameY, left: 0, width: frameLayout.frameX, height: frameLayout.frameHeight }]} />
      <View style={[styles.overlay, { top: frameLayout.frameY, right: 0, width: frameLayout.frameX, height: frameLayout.frameHeight }]} />

      {/* Frame border */}
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

      {/* Instruction text */}
      <View style={styles.instructionContainer}>
        <Text style={styles.instructionText}>Place your ID inside the frame</Text>
      </View>

      {/* Capture button */}
      <View style={styles.captureContainer}>
        <TouchableOpacity
          style={[styles.captureButton, isCapturing && styles.captureButtonDisabled]}
          onPress={capturePhotoManually}
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

      {/* Result info */}
      {base64Data && (
        <View style={styles.debugInfo}>
          <Text style={styles.debugText}>
            ✓ Captured ({Math.round(base64Data.length / 1024)}KB)
          </Text>
          {savedPath && (
            <Text style={styles.debugText} numberOfLines={1}>
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

  // Native scanner mode styles
  nativeScannerOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0, 0, 0, 0.85)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  nativeScannerContent: {
    alignItems: 'center',
    maxWidth: 320,
  },
  nativeScannerTitle: {
    color: '#ffffff',
    fontSize: 24,
    fontWeight: 'bold',
    marginBottom: 16,
    textAlign: 'center',
  },
  nativeScannerDescription: {
    color: 'rgba(255, 255, 255, 0.8)',
    fontSize: 16,
    textAlign: 'center',
    marginBottom: 32,
    lineHeight: 24,
  },
  scanButton: {
    backgroundColor: '#007AFF',
    paddingVertical: 20,
    paddingHorizontal: 40,
    borderRadius: 16,
    alignItems: 'center',
    minWidth: 200,
    marginBottom: 16,
  },
  scanButtonDisabled: {
    opacity: 0.6,
  },
  scanButtonIcon: {
    fontSize: 32,
    marginBottom: 8,
  },
  scanButtonText: {
    color: '#ffffff',
    fontSize: 18,
    fontWeight: '600',
  },
  nativeScannerHint: {
    color: 'rgba(255, 255, 255, 0.5)',
    fontSize: 14,
    textAlign: 'center',
  },
  resultBadge: {
    position: 'absolute',
    bottom: 40,
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

  // Manual mode styles
  overlay: {
    position: 'absolute',
    backgroundColor: `rgba(0, 0, 0, ${OVERLAY_OPACITY})`,
  },

  frame: {
    position: 'absolute',
    borderWidth: 2,
    borderColor: '#ffffff',
    borderRadius: 12,
  },

  corner: {
    position: 'absolute',
    width: 24,
    height: 24,
    borderColor: '#ffffff',
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

  instructionContainer: {
    position: 'absolute',
    top: 80,
    left: 20,
    right: 20,
    alignItems: 'center',
  },
  instructionText: {
    color: '#ffffff',
    fontSize: 18,
    fontWeight: '600',
    textAlign: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    paddingHorizontal: 20,
    paddingVertical: 10,
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
    backgroundColor: '#ffffff',
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
    backgroundColor: '#ffffff',
    borderWidth: 2,
    borderColor: '#cccccc',
  },
  captureHint: {
    color: '#ffffff',
    fontSize: 14,
    marginTop: 12,
    opacity: 0.8,
  },

  statusText: {
    color: '#ffffff',
    fontSize: 16,
    textAlign: 'center',
    marginBottom: 20,
  },
  permissionButton: {
    backgroundColor: '#007AFF',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 8,
  },
  permissionButtonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
  },

  debugInfo: {
    position: 'absolute',
    bottom: 160,
    left: 20,
    right: 20,
    backgroundColor: 'rgba(0, 128, 0, 0.8)',
    padding: 10,
    borderRadius: 8,
  },
  debugText: {
    color: '#ffffff',
    fontSize: 12,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
});
