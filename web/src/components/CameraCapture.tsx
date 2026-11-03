'use client';

import { useRef, useState, useEffect, useCallback } from 'react';
import { Camera, X, RotateCcw, ZoomIn } from 'lucide-react';
import { Button } from '@/components/ui/Button';

interface CameraCaptureProps {
  onCapture: (file: File) => void;
  onClose: () => void;
  /** Escape hatch to the device's own camera app (an <input capture> click).
   *  Whether the in-page camera can work is only knowable once getUserMedia
   *  runs — a denied permission or a machine with no camera both look fine
   *  beforehand — so the caller can't decide it in advance and this component
   *  has to be able to hand the job back. Without it the error state offers
   *  only "try again", which fails again for exactly the same reason. */
  onFallback?: () => void;
}

type FacingMode = 'environment' | 'user';
type PermStatus = 'requesting' | 'granted' | 'denied' | 'error';

export default function CameraCapture({ onCapture, onClose, onFallback }: CameraCaptureProps) {
  const videoRef      = useRef<HTMLVideoElement>(null);
  const canvasRef     = useRef<HTMLCanvasElement>(null);
  const streamRef     = useRef<MediaStream | null>(null);
  const mountedRef    = useRef(true);
  const capturingRef  = useRef(false);

  const [facing, setFacing] = useState<FacingMode>('environment');
  const [status, setStatus] = useState<PermStatus>('requesting');
  const [errMsg, setErrMsg] = useState('');
  const [flash, setFlash] = useState(false);

  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
  }, []);

  const startCamera = useCallback(async (mode: FacingMode) => {
    stopStream();
    if (mountedRef.current) setStatus('requesting');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: mode },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
        audio: false,
      });
      // Component may have unmounted while getUserMedia was awaiting
      if (!mountedRef.current) {
        stream.getTracks().forEach(t => t.stop());
        return;
      }
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        // playsInline is the critical iOS fix — without it, iOS shows black
        videoRef.current.setAttribute('playsinline', 'true');
        await videoRef.current.play();
      }
      if (mountedRef.current) setStatus('granted');
    } catch (err: unknown) {
      if (!mountedRef.current) return;
      const error = err as { name?: string; message?: string };
      if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
        setStatus('denied');
        setErrMsg('אנא אפשר גישה למצלמה בהגדרות הדפדפן ונסה שוב');
      } else if (error.name === 'NotFoundError') {
        setStatus('error');
        setErrMsg('לא נמצאה מצלמה במכשיר');
      } else {
        setStatus('error');
        setErrMsg(error.message || 'שגיאה בפתיחת המצלמה');
      }
    }
  }, [stopStream]);

  useEffect(() => {
    mountedRef.current = true;
    startCamera(facing);
    return () => {
      mountedRef.current = false;
      stopStream();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleFacing = () => {
    const next: FacingMode = facing === 'environment' ? 'user' : 'environment';
    setFacing(next);
    startCamera(next);
  };

  const capture = () => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || status !== 'granted' || capturingRef.current) return;
    capturingRef.current = true;

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.drawImage(video, 0, 0);

    setFlash(true);
    setTimeout(() => setFlash(false), 200);

    canvas.toBlob(blob => {
      if (!blob) return;
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const file = new File([blob], `invoice-${ts}.jpg`, { type: 'image/jpeg' });
      onCapture(file);
      stopStream();
      onClose();
    }, 'image/jpeg', 0.92);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-black"
      style={{ touchAction: 'none' }}
    >
      {/* Flash effect */}
      {flash && <div className="absolute inset-0 bg-white z-10 pointer-events-none opacity-80" />}

      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 bg-black/80 z-20">
        <button onClick={() => { stopStream(); onClose(); }} className="text-white p-1">
          <X className="w-6 h-6" />
        </button>
        <span className="text-white text-sm font-medium">צלם חשבונית</span>
        <button onClick={toggleFacing} className="text-white p-1" title="החלף מצלמה">
          <RotateCcw className="w-6 h-6" />
        </button>
      </div>

      {/* Video */}
      <div className="flex-1 relative flex items-center justify-center overflow-hidden">
        {status === 'requesting' && (
          <div className="text-white text-center p-6">
            <Camera className="w-12 h-12 mx-auto mb-3 animate-pulse" />
            <p>מאתחל מצלמה…</p>
          </div>
        )}

        {(status === 'denied' || status === 'error') && (
          <div className="text-white text-center p-6 max-w-xs mx-auto">
            <Camera className="w-12 h-12 mx-auto mb-3 text-red-400" />
            <p className="mb-4 text-sm leading-relaxed">{errMsg}</p>
            <div className="flex flex-col gap-2.5">
              {/* Retrying is worth offering — a denied permission can be granted
                  from the browser's address bar and then works. But it is the
                  wrong and only option when the device simply has no camera, so
                  the way out is offered alongside it rather than instead. */}
              <Button variant="outline" className="text-white border-white" onClick={() => startCamera(facing)}>
                נסה שוב
              </Button>
              {onFallback && (
                <>
                  <button
                    onClick={() => { stopStream(); onFallback(); }}
                    className="text-sm font-semibold underline underline-offset-4 text-white/90 hover:text-white"
                  >
                    פתח את מצלמת המכשיר במקום
                  </button>
                  <p className="text-xs text-white/50 leading-relaxed">
                    מצלמת המכשיר עובדת גם בלי הרשאת דפדפן — התמונה תיקלט ותעלה בדיוק אותו דבר.
                  </p>
                </>
              )}
            </div>
          </div>
        )}

        <video
          ref={videoRef}
          className="w-full h-full object-cover"
          autoPlay
          playsInline
          muted
          style={{ display: status === 'granted' ? 'block' : 'none' }}
        />

        {/* Framing guide */}
        {status === 'granted' && (
          <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
            <div className="border-2 border-white/60 rounded-lg" style={{ width: '85%', height: '55%' }}>
              <div className="absolute top-1 left-1/2 -translate-x-1/2 bg-black/50 text-white text-xs px-2 py-0.5 rounded">
                <ZoomIn className="w-3 h-3 inline ml-1" />מקם את החשבונית בתוך המסגרת
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Capture button */}
      <div className="flex items-center justify-center py-8 bg-black/80">
        <button
          onClick={capture}
          disabled={status !== 'granted'}
          className="w-20 h-20 rounded-full bg-white disabled:opacity-40 flex items-center justify-center shadow-lg active:scale-95 transition-transform"
        >
          <Camera className="w-8 h-8 text-gray-800" />
        </button>
      </div>

      <canvas ref={canvasRef} className="hidden" />
    </div>
  );
}
