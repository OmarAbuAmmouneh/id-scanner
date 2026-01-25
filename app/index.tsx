// Original IDScanner (uses native document scanner + ML Kit OCR)
import IDScannerOpenCV from '../components/IDScannerOpenCV';

// Experimental OpenCV Scanner (requires native rebuild, has issues)
// import IDScannerOpenCV from '../components/IDScannerOpenCV';

export default function MainScreen() {
  const handleCapture = (result: { filePath: string; base64: string; nativeScanner?: boolean }) => {
    // You can send the base64 or filePath to your backend here
  };

  return (
    <IDScannerOpenCV
    saveToGallery={true}
    onCapture={handleCapture}
  />
  );
}
