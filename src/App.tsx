import React, { useEffect, useRef, useState } from 'react';
import { HandLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';
import { Soundfont } from 'smplr';

// --- Configuration ---
const PINCH_THRESHOLD = 0.05; 
const STRUM_THRESHOLD = 0.05; 

const NOTE_BASE: Record<string, number> = {
  'C': 0, 'C#': 1, 'Db': 1, 'D': 2, 'D#': 3, 'Eb': 3, 'E': 4, 'F': 5, 'F#': 6, 'Gb': 6, 'G': 7, 'G#': 8, 'Ab': 8, 'A': 9, 'A#': 10, 'Bb': 10, 'B': 11
};
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

function getChordNotes(chordName: string): string[] {
  if (chordName === 'None' || !chordName) return [];
  const match = chordName.match(/^([A-G][#b]?)(.*)$/);
  if (!match) return [];
  const root = match[1];
  const type = match[2];

  const rootVal = NOTE_BASE[root];
  
  let intervals = [0, 4, 7]; 
  if (type === 'm') intervals = [0, 3, 7];
  else if (type === 'dim') intervals = [0, 3, 6];
  else if (type === '7') intervals = [0, 4, 7, 10];
  else if (type === 'maj7') intervals = [0, 4, 7, 11];
  else if (type === 'm7') intervals = [0, 3, 7, 10];
  else if (type === 'sus4') intervals = [0, 5, 7];
  
  const bassOctave = (rootVal >= 4) ? 2 : 3;
  const bassMidi = rootVal + (bassOctave + 1) * 12; 
  
  const notes = [];
  notes.push(rootVal);
  notes.push(rootVal + 7);
  notes.push(rootVal + 12);
  notes.push(rootVal + 12 + (intervals[1] || 4));
  if (intervals.length > 3) {
    notes.push(rootVal + 12 + intervals[3]);
  } else {
    notes.push(rootVal + 24 + (intervals[2] || 7));
  }
  
  return notes.map(val => {
    let offset = val - rootVal;
    let absolute = bassMidi + offset;
    let noteIdx = absolute % 12;
    let oct = Math.floor(absolute / 12) - 1;
    return `${NOTE_NAMES[noteIdx]}${oct}`;
  });
}

function getDiatonicChords(key: string) {
  const rootIdx = NOTE_BASE[key];
  const scaleIntervals = [0, 2, 4, 5, 7, 9, 11];
  const scaleNotes = scaleIntervals.map(interval => NOTE_NAMES[(rootIdx + interval) % 12]);
  
  const row1 = [
    `${scaleNotes[0]}`,
    `${scaleNotes[1]}m`,
    `${scaleNotes[2]}m`,
    `${scaleNotes[3]}`,
    `${scaleNotes[4]}`,
    `${scaleNotes[5]}m`,
    `${scaleNotes[6]}dim`,
  ];
  
  const row2 = [
    `${scaleNotes[0]}maj7`,
    `${scaleNotes[1]}m7`,
    `${scaleNotes[2]}m7`,
    `${scaleNotes[3]}maj7`,
    `${scaleNotes[4]}7`,
    `${scaleNotes[5]}m7`,
    `${scaleNotes[4]}sus4`, 
  ];

  return [row1, row2];
}

const ALL_KEYS = ['C', 'G', 'D', 'A', 'E', 'B', 'F#', 'Db', 'Ab', 'Eb', 'Bb', 'F'];

const GRID_COLS = 7;
const GRID_ROWS = 2;
const GRID_START_X = 0.10; 
const GRID_START_Y = 0.35; 
const GRID_WIDTH = 0.80;   
const GRID_HEIGHT = 0.30;  

const App: React.FC = () => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const landmarkerRef = useRef<HandLandmarker | null>(null);
  const requestRef = useRef<number>();
  
  const [isLoaded, setIsLoaded] = useState(false);
  const [hasStarted, setHasStarted] = useState(false);
  const [cameraError, setCameraError] = useState("");
  const [currentChord, setCurrentChord] = useState<string>('None');
  const [currentKey, setCurrentKey] = useState<string>('C');

  const chordMapRef = useRef<string[][]>(getDiatonicChords('C'));

  const [arpeggioMode, setArpeggioModeUI] = useState(false);
  const [bpm, setBpmUI] = useState(120);

  const arpeggioModeRef = useRef(false);
  const bpmRef = useRef(120);

  const toggleArpeggio = (val: boolean) => {
    arpeggioModeRef.current = val;
    setArpeggioModeUI(val);
  };

  const handleBpmChange = (val: number) => {
    bpmRef.current = val;
    setBpmUI(val);
  };

  useEffect(() => {
    chordMapRef.current = getDiatonicChords(currentKey);
  }, [currentKey]);

  const acRef = useRef<AudioContext | null>(null);
  const instrumentRef = useRef<any>(null);
  
  const lastRightHandY = useRef<number>(0);
  const isStrumming = useRef<boolean>(false);
  const lastStrumTime = useRef<number>(0);
  const lastVideoTimeRef = useRef<number>(-1);

  // Initialize MediaPipe
  useEffect(() => {
    const loadAiModel = async () => {
      try {
        const vision = await FilesetResolver.forVisionTasks(
          "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm"
        );
        landmarkerRef.current = await HandLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: `https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task`,
            delegate: "GPU"
          },
          runningMode: "VIDEO",
          numHands: 2
        });
        setIsLoaded(true);
      } catch (err) {
        console.error("AI Model Load Error:", err);
        setCameraError("Failed to initialize AI model. Please check network.");
      }
    };
    loadAiModel();
    return () => {
      if (requestRef.current) cancelAnimationFrame(requestRef.current);
    };
  }, []);

  // System Setup (Camera & Audio)
  const handleStartSystem = async () => {
    try {
      const AudioContextCtor = window.AudioContext || (window as any).webkitAudioContext;
      const ac = new AudioContextCtor();
      acRef.current = ac;
      
      // Load higher quality acoustic guitar
      const guitar = Soundfont(ac, { instrument: "acoustic_guitar_steel" });
      guitar.ready.then(() => {
        instrumentRef.current = guitar;
      });

      // Webcam setup
      if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        setCameraError(""); // Reset error state just in case
        const stream = await navigator.mediaDevices.getUserMedia({ 
          video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } } 
        });
        
        const video = videoRef.current;
        if (video) {
          video.srcObject = stream;
          // Play inline and muted guarantees auto-play constraints are met in most browsers
          video.muted = true;
          video.playsInline = true;

          video.onloadedmetadata = () => {
            video.play().catch(e => {
              console.error("Video play error:", e);
              setCameraError("Video playback was blocked by browser. Please interact with the page and ensure permissions.");
            });
          };

          video.addEventListener("loadeddata", () => {
            if (videoRef.current) {
              videoRef.current.width = videoRef.current.videoWidth;
              videoRef.current.height = videoRef.current.videoHeight;
              predictWebcam();
            }
          });
        }
      } else {
         throw new Error("getUserMedia not supported");
      }
      setHasStarted(true);
    } catch (err) {
      console.error("System Start Error:", err);
      if ((err as Error).name === 'NotAllowedError') {
        setCameraError("Camera permission denied. Please enable camera access in your browser settings and try again.");
      } else {
        setCameraError("Could not start video source. Camera might be in use or permission denied.");
      }
    }
  };

  // Tracking & Drawing Loop
  const predictWebcam = () => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    const landmarker = landmarkerRef.current;

    if (!video || !canvas || !landmarker) return;

    if (video.videoWidth === 0 || video.videoHeight === 0) {
      requestRef.current = requestAnimationFrame(predictWebcam);
      return;
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    try {
      let startTimeMs = performance.now();
      if (startTimeMs <= lastVideoTimeRef.current) {
        startTimeMs = lastVideoTimeRef.current + 1;
      }
      lastVideoTimeRef.current = startTimeMs;

      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;

      const results = landmarker.detectForVideo(video, startTimeMs);

      ctx.save();
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      
      // Draw webcam flipped (mirror)
      ctx.save();
      ctx.scale(-1, 1);
      ctx.translate(-canvas.width, 0);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      ctx.restore();

      let detectedChord = 'None';

      if (results.landmarks && results.handednesses) {
        for (let i = 0; i < results.landmarks.length; i++) {
          const landmarks = results.landmarks[i];
          const handedness = results.handednesses[i][0].categoryName;

          const isLeftHand = handedness === "Left";

          // Subtle tracker rendering: Blue for Left hand (Chord Grid), Red for Right hand (Strumming)
          ctx.fillStyle = isLeftHand ? "rgba(59, 130, 246, 0.8)" : "rgba(239, 68, 68, 0.8)";
          landmarks.forEach((point) => {
            const pxX = (1 - point.x) * canvas.width;
            const pxY = point.y * canvas.height;
            ctx.beginPath();
            ctx.arc(pxX, pxY, 4, 0, 2 * Math.PI);
            ctx.fill();
          });

          const thumbTip = landmarks[4];
          const indexTip = landmarks[8];

          if (isLeftHand) {
            // Left hand: Chord Grid Pinch
            const distance = Math.hypot(thumbTip.x - indexTip.x, thumbTip.y - indexTip.y);
            if (distance < PINCH_THRESHOLD) {
              const screenX = 1.0 - indexTip.x; 
              const screenY = indexTip.y;
              
              const pxX = screenX * canvas.width;
              const pxY = screenY * canvas.height;
              
              if (screenX >= GRID_START_X && screenX <= GRID_START_X + GRID_WIDTH &&
                  screenY >= GRID_START_Y && screenY <= GRID_START_Y + GRID_HEIGHT) {
                  
                  const col = Math.floor((screenX - GRID_START_X) / (GRID_WIDTH / GRID_COLS));
                  const row = Math.floor((screenY - GRID_START_Y) / (GRID_HEIGHT / GRID_ROWS));
                  
                  if (row >= 0 && row < GRID_ROWS && col >= 0 && col < GRID_COLS) {
                     detectedChord = chordMapRef.current[row][col];
                     
                     ctx.fillStyle = "rgba(45, 212, 191, 0.9)"; 
                     ctx.beginPath();
                     ctx.arc(pxX, pxY, 12, 0, 2 * Math.PI);
                     ctx.fill();
                  }
              }
            }
          } else {
            // Right hand: Strumming
            const currentY = indexTip.y;
            const velocity = currentY - lastRightHandY.current;
            
            if (velocity > STRUM_THRESHOLD && !isStrumming.current) {
               const nowTime = performance.now();
               if (nowTime - lastStrumTime.current > 250) { // Strum debounce
                 isStrumming.current = true;
                 lastStrumTime.current = nowTime;
                 
                 setCurrentChord((prevChord) => {
                   playChord(prevChord);
                   return prevChord; 
                 });
                 
                 const pxX = (1 - indexTip.x) * canvas.width;
                 const pxY = indexTip.y * canvas.height;
                 ctx.fillStyle = "rgba(255, 255, 255, 0.9)";
                 ctx.beginPath();
                 ctx.arc(pxX, pxY, 20, 0, 2 * Math.PI);
                 ctx.fill();
               }
            } else if (velocity < -0.02) { 
               isStrumming.current = false;
            }
            lastRightHandY.current = currentY;
          }
        }
      }
      
      // Mute logic based on left hand pinch state
      setCurrentChord((prevChord) => {
        if (detectedChord !== prevChord) {
          if (detectedChord === 'None' && instrumentRef.current) {
            // Pinch released -> mute the strings (sustain ends)
            instrumentRef.current.stop();
          } else if (detectedChord !== 'None' && instrumentRef.current) {
            // Changed to a new chord -> stop previous sound to avoid muddiness
            instrumentRef.current.stop();
          }
        }
        return detectedChord;
      });

      drawChordGrid(ctx, canvas.width, canvas.height, detectedChord);

      ctx.restore();
    } catch (e) {
      console.error("Landmarker error:", e);
    }
    requestRef.current = requestAnimationFrame(predictWebcam);
  };

  // Audio Playback
  const playChord = (chordName: string) => {
    if (chordName === 'None' || !instrumentRef.current || !acRef.current) return;
    const notes = getChordNotes(chordName);
    if (notes && notes.length > 0) {
      const now = acRef.current.currentTime;
      const isArp = arpeggioModeRef.current;
      const currentBpm = bpmRef.current;

      notes.forEach((note, index) => {
        // Natural arpeggiated strum delay or full arpeggio mode
        const delay = isArp ? index * (60 / currentBpm) : index * 0.02 + Math.random() * 0.01;
        instrumentRef.current.start({
          note: note,
          time: now + delay,
          duration: isArp ? (60 / currentBpm) * 1.5 : 8, // Very long duration to allow sustaining until pinch is released
          velocity: Math.floor(70 + Math.random() * 30) // Varying velocity for realism
        });
      });
    }
  };

  // Clean UI Components
  const drawChordGrid = (ctx: CanvasRenderingContext2D, width: number, height: number, activeChord: string) => {
    const gridPxX = GRID_START_X * width;
    const gridPxY = GRID_START_Y * height;
    const gridPxW = GRID_WIDTH * width;
    const gridPxH = GRID_HEIGHT * height;
    
    const cellW = gridPxW / GRID_COLS;
    const cellH = gridPxH / GRID_ROWS;

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    for (let r = 0; r < GRID_ROWS; r++) {
      for (let c = 0; c < GRID_COLS; c++) {
        const chord = chordMapRef.current[r][c];
        const isSelected = chord === activeChord && activeChord !== 'None';
        
        const cx = gridPxX + c * cellW;
        const cy = gridPxY + r * cellH;
        
        ctx.beginPath();
        ctx.rect(cx, cy, cellW, cellH);
        
        if (isSelected) {
          ctx.fillStyle = "rgba(45, 212, 191, 0.4)"; // Teal selection
          ctx.fill();
        } else {
          ctx.fillStyle = "rgba(0, 0, 0, 0.4)"; // Clean dark background
          ctx.fill();
        }
        
        ctx.strokeStyle = isSelected ? "rgba(45, 212, 191, 1)" : "rgba(255, 255, 255, 0.2)";
        ctx.lineWidth = isSelected ? 3 : 1;
        ctx.stroke();

        ctx.fillStyle = isSelected ? "#fff" : "rgba(255, 255, 255, 0.8)";
        ctx.font = isSelected ? "bold 24px 'Inter', sans-serif" : "600 18px 'Inter', sans-serif";
        ctx.fillText(chord, cx + cellW / 2, cy + cellH / 2);
      }
    }
  };

  return (
    <div className="relative w-full h-screen bg-neutral-900 text-white overflow-hidden font-sans">
      <video ref={videoRef} autoPlay playsInline muted className="hidden" />
      <canvas ref={canvasRef} className="absolute inset-0 w-full h-full object-cover z-0" />
      
      {/* Onboarding / Setup Screen */}
      {!hasStarted && (
        <div className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-neutral-950/80 backdrop-blur-md">
          <div className="glass-panel p-10 max-w-lg w-full flex flex-col items-center text-center">
            {!isLoaded ? (
              <>
                <div className="w-10 h-10 border-4 border-teal-400 border-t-transparent rounded-full animate-spin mb-6"></div>
                <h2 className="text-lg font-semibold tracking-wide text-neutral-200">Loading AI Engine...</h2>
                <p className="text-sm text-neutral-400 mt-2">Preparing computer vision models</p>
              </>
            ) : (
              <>
                <h1 className="text-3xl font-bold tracking-tight text-white mb-2">Withus Air Guitar</h1>
                <p className="text-neutral-400 mb-8 max-w-sm">
                  Allow camera permissions to start. Use your left hand to select chords and right hand to strum downward.
                </p>
                {cameraError && (
                  <div className="w-full p-4 mb-6 bg-red-500/10 border border-red-500/30 text-red-400 text-sm rounded-md">
                    {cameraError}
                  </div>
                )}
                <button 
                  onClick={handleStartSystem}
                  className="px-8 py-3 bg-white text-black font-semibold rounded-full hover:bg-neutral-200 transition-colors"
                >
                  Start Session
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* Top Header */}
      {hasStarted && (
        <header className="absolute top-0 left-0 w-full p-6 flex items-center justify-between z-40 pointer-events-auto">
          <div>
            <h1 className="text-xl font-bold tracking-tight text-white drop-shadow-md">Withus Air Guitar</h1>
            <p className="text-xs font-medium text-neutral-200 opacity-80 mt-1 drop-shadow-sm pointer-events-none">
              Right hand downstrum / Left hand pinch
            </p>
          </div>
          
          <div className="flex gap-4">
            <div className="glass-panel px-4 py-2 flex items-center gap-4 pointer-events-auto">
              <label className="flex items-center gap-2 cursor-pointer">
                <input 
                  type="checkbox" 
                  checked={arpeggioMode} 
                  onChange={(e) => toggleArpeggio(e.target.checked)}
                  className="w-4 h-4 accent-teal-400"
                />
                <span className="text-xs font-bold tracking-wider text-neutral-400 uppercase">Arpeggio</span>
              </label>
              
              {arpeggioMode && (
                <div className="flex items-center gap-3 text-xs font-bold text-neutral-400 bg-black/30 px-3 py-1 rounded-full border border-white/5">
                  <span className="w-14 text-right">BPM {bpm}</span>
                  <input 
                    type="range" 
                    min="60" 
                    max="240" 
                    value={bpm} 
                    onChange={(e) => handleBpmChange(parseInt(e.target.value))}
                    className="w-24 accent-teal-400" 
                  />
                </div>
              )}
            </div>

            <div className="glass-panel px-4 py-2 flex items-center gap-2 pointer-events-auto">
              <span className="text-xs font-bold tracking-wider text-neutral-400 mr-2 uppercase">Key</span>
              <div className="flex bg-black/30 rounded-full p-1 border border-white/5 max-w-[300px] overflow-x-auto hide-scrollbar space-x-1">
                {ALL_KEYS.map(key => (
                  <button
                    key={key}
                    onClick={() => setCurrentKey(key)}
                    className={`shrink-0 w-8 h-8 flex items-center justify-center rounded-full text-xs font-bold transition-all ${
                      currentKey === key 
                        ? 'bg-teal-400 text-black shadow-[0_0_10px_rgba(45,212,191,0.5)]' 
                        : 'text-neutral-400 hover:text-white hover:bg-white/10'
                    }`}
                  >
                    {key}
                  </button>
                ))}
              </div>
            </div>

            <div className="glass-panel px-4 py-2 flex items-center gap-2 pointer-events-none">
              <div className="w-2 h-2 rounded-full bg-teal-400 animate-pulse"></div>
              <span className="text-xs font-medium tracking-wide">AI ACTIVE</span>
            </div>
          </div>
        </header>
      )}

      {/* Bottom Interface */}
      {hasStarted && (
        <div className="absolute bottom-6 left-6 right-6 z-40 gap-4 flex pointer-events-none justify-between items-end">
          <div className="glass-panel px-6 py-4 min-w-[200px]">
            <span className="block text-[10px] font-bold text-neutral-400 mb-1 uppercase tracking-wider">Current Chord</span>
            <div className="text-4xl font-bold text-white tracking-widest">
              {currentChord === 'None' ? '--' : currentChord}
            </div>
          </div>
          
          <div className="glass-panel px-6 py-4 flex gap-8">
             <div className="flex flex-col">
               <span className="text-[10px] font-bold text-neutral-400 mb-1 uppercase tracking-wider">Left Hand</span>
               <span className="text-sm font-semibold text-white">Grid Selection</span>
             </div>
             <div className="flex flex-col">
               <span className="text-[10px] font-bold text-neutral-400 mb-1 uppercase tracking-wider">Right Hand</span>
               <span className="text-sm font-semibold text-white">Downwards Strum</span>
             </div>
             <div className="flex flex-col">
               <span className="text-[10px] font-bold text-neutral-400 mb-1 uppercase tracking-wider">Sound Engine</span>
               <span className="text-sm font-semibold text-white">Steel Acoustic</span>
             </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default App;

