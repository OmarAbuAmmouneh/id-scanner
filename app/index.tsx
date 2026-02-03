import VisionCropCamera from "@/components/VisionCropCamera";
export default function MainScreen() {
  const handleCapture = (photoPath: string) => {
    console.log('Captured:', photoPath);
  };
  return <VisionCropCamera/>
  // return <GeminiCropCamera/>
 }
