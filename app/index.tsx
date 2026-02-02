import CameraOverlayCrop from '@/components/CameraOverlayCrop';
import GeminiCropCamera from "@/components/GeminiCropCamera";

export default function MainScreen() {
  const handleCapture = (photoPath: string) => {
    console.log('Captured:', photoPath);
  };
  return <GeminiCropCamera/>
  // return <CameraOverlayCrop />;
}
