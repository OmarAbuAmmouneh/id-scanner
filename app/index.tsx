import CameraOverlayCrop from '@/components/CameraOverlayCrop';

export default function MainScreen() {
  const handleCapture = (photoPath: string) => {
    console.log('Captured:', photoPath);
  };

  return <CameraOverlayCrop />;
}
