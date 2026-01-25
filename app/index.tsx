import IDScanner from '../components/IDScanner';

export default function MainScreen() {
  const handleCapture = (result: { filePath: string; base64: string; nativeScanner?: boolean }) => {
    // You can send the base64 or filePath to your backend here
  };

  return (
    <IDScanner
      useNativeScanner={true}
      saveToGallery={true}
      onCapture={handleCapture}
    />
  );
}
