import React, { useState, useEffect, useRef } from 'react';
import './App.css';
import WaveSurfer from 'wavesurfer.js';
import { Line } from 'react-chartjs-2';
import { Chart as ChartJS, LineElement, CategoryScale, LinearScale, PointElement } from 'chart.js';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile } from '@ffmpeg/util';

ChartJS.register(LineElement, CategoryScale, LinearScale, PointElement);

function App() {
  const [ttsAudioURL, setTtsAudioURL] = useState(null);
  const [recordingAudioURL, setRecordingAudioURL] = useState(null);

  const [aiPitchAnalysis, setAiPitchAnalysis] = useState([]);
  const [userPitchAnalysis, setUserPitchAnalysis] = useState([]);

  const [mediaRecorder, setMediaRecorder] = useState(null);
  const [recording, setRecording] = useState(false);

  // WaveSurfer references
  const ttsWaveformRef = useRef(null);
  const recordWaveformRef = useRef(null);
  const ttsWavesurferRef = useRef(null);
  const recordWavesurferRef = useRef(null);

  // FFmpeg instance
  const ffmpegRef = useRef(new FFmpeg({ log: true }));

  // TTS text, API key, and loading state
  const [text, setText] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [loading, setLoading] = useState(false);

  // -----------------------------
  // 2) States for forced alignment
  // -----------------------------
  const [forcedAlignmentTranscript, setForcedAlignmentTranscript] = useState("");
  const [ttsWavBlob, setTtsWavBlob] = useState(null);    // Store TTS WAV for re-use
  const [userWavBlob, setUserWavBlob] = useState(null);  // Store user WAV for re-use
  const [aiAlignmentData, setAiAlignmentData] = useState([]);     // TTS alignment result
  const [userAlignmentData, setUserAlignmentData] = useState([]); // User alignment result

  // ----------------------------------------------------------------
  // 3) Generate TTS (MP3) -> Convert to WAV -> Analyze -> aiPitchAnalysis
  // ----------------------------------------------------------------
  const handleGenerateAudio = async () => {
    if (!text || !apiKey) {
      alert("Please provide text and an OpenAI API key.");
      return;
    }

    setLoading(true);
    setAiPitchAnalysis([]); // Clear old AI pitch if any

    try {
      const response = await fetch("/api/text_to_speech", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, api_key: apiKey }),
      });

      if (!response.ok) {
        throw new Error(`Server responded with ${response.status}`);
      }

      // Get MP3 and create a Blob URL
      const mp3Blob = await response.blob();
      const mp3Url = URL.createObjectURL(mp3Blob);
      setTtsAudioURL(mp3Url);

      // Convert MP3 -> WAV -> fetch AI pitch
      const wavBlob = await convertMp3ToWav(mp3Blob);
      setTtsWavBlob(wavBlob); // <-- store the WAV for forced alignment
      const pitchResult = await fetchAiPitch(wavBlob);
      setAiPitchAnalysis(pitchResult);
    } catch (err) {
      console.error("Error generating TTS audio:", err);
      alert("Error generating audio. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  // ----------------------------------------------------------------
  // 4) Convert MP3 -> WAV (FFmpeg)
  // ----------------------------------------------------------------
  const convertMp3ToWav = async (mp3Blob) => {
    const ffmpeg = ffmpegRef.current;
    if (!ffmpeg.loaded) {
      await ffmpeg.load();
    }
    const inputMp3 = "tts_input.mp3";
    const outputWav = "tts_output.wav";

    await ffmpeg.writeFile(inputMp3, await fetchFile(mp3Blob));
    await ffmpeg.exec(["-i", inputMp3, outputWav]);
    const wavData = await ffmpeg.readFile(outputWav);

    return new Blob([wavData.buffer], { type: "audio/wav" });
  };

  // ----------------------------------------------------------------
  // 5) AI Pitch Endpoint 
  // ----------------------------------------------------------------
  const fetchAiPitch = async (wavBlob) => {
    try {
      const formData = new FormData();
      formData.append("audio", wavBlob, "tts.wav");

      const response = await fetch("/api/analyze_pitch", {
        method: "POST",
        body: formData,
      });
      if (!response.ok) {
        throw new Error(`Server responded with ${response.status}`);
      }

      const result = await response.json();
      if (
        Array.isArray(result) &&
        result.every((item) => "time" in item && "frequency" in item)
      ) {
        return result;
      } else {
        console.error("Invalid AI pitch data:", result);
        return [];
      }
    } catch (err) {
      console.error("Error analyzing AI pitch:", err);
      return [];
    }
  };

  // ----------------------------------------------------------------
  // 6) WaveSurfer for TTS
  // ----------------------------------------------------------------
  useEffect(() => {
    if (ttsAudioURL && ttsWaveformRef.current) {
      if (ttsWavesurferRef.current) {
        ttsWavesurferRef.current.destroy();
      }
      ttsWavesurferRef.current = WaveSurfer.create({
        container: ttsWaveformRef.current,
        waveColor: "#a4b0be",
        progressColor: "#57606f",
        cursorColor: "#ff4757",
      });
      ttsWavesurferRef.current.load(ttsAudioURL);
    }
  }, [ttsAudioURL]);

  // ----------------------------------------------------------------
  // 7) Recording: WebM -> WAV -> userPitchAnalysis
  // ----------------------------------------------------------------
  const handleStartRecording = async () => {
    try {
      setRecordingAudioURL(null);
      setUserPitchAnalysis([]); // Clear old user pitch
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);

      const chunks = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          chunks.push(e.data);
        }
      };

      recorder.onstop = async () => {
        if (chunks.length > 0) {
          const webmBlob = new Blob(chunks, { type: "audio/webm" });
          const webmUrl = URL.createObjectURL(webmBlob);
          setRecordingAudioURL(webmUrl);

          // Convert WebM -> WAV -> user pitch
          const wavBlob = await convertWebmToWav(webmBlob);
          setUserWavBlob(wavBlob); // <-- IMPORTANT: store the WAV for forced alignment
          const pitchResult = await fetchUserPitch(wavBlob);
          setUserPitchAnalysis(pitchResult);
        }
      };

      recorder.start();
      setMediaRecorder(recorder);
      setRecording(true);
    } catch (err) {
      console.error("Error starting recording:", err);
    }
  };

  const handleStopRecording = () => {
    if (mediaRecorder) {
      mediaRecorder.stop();
      setRecording(false);
    }
  };

  // ----------------------------------------------------------------
  // 8) Convert WebM -> WAV
  // ----------------------------------------------------------------
  const convertWebmToWav = async (webmBlob) => {
    const ffmpeg = ffmpegRef.current;
    if (!ffmpeg.loaded) {
      await ffmpeg.load();
    }
    const inputWebm = "user_input.webm";
    const outputWav = "user_output.wav";

    await ffmpeg.writeFile(inputWebm, await fetchFile(webmBlob));
    await ffmpeg.exec(["-i", inputWebm, outputWav]);
    const wavData = await ffmpeg.readFile(outputWav);

    return new Blob([wavData.buffer], { type: "audio/wav" });
  };

  // ----------------------------------------------------------------
  // 9) User Pitch Endpoint
  // ----------------------------------------------------------------
  const fetchUserPitch = async (wavBlob) => {
    try {
      const formData = new FormData();
      formData.append("audio", wavBlob, "recording.wav");

      const response = await fetch("/api/analyze_pitch", {
        method: "POST",
        body: formData,
      });
      if (!response.ok) {
        throw new Error(`Server responded with status ${response.status}`);
      }

      const result = await response.json();
      if (
        Array.isArray(result) &&
        result.every((item) => "time" in item && "frequency" in item)
      ) {
        return result;
      } else {
        console.error("Invalid user pitch data:", result);
        return [];
      }
    } catch (err) {
      console.error("Error analyzing user pitch:", err);
      return [];
    }
  };

  // ----------------------------------------------------------------
  // 10) WaveSurfer for User Recording
  // ----------------------------------------------------------------
  useEffect(() => {
    if (recordingAudioURL && recordWaveformRef.current) {
      if (recordWavesurferRef.current) {
        recordWavesurferRef.current.destroy();
      }
      recordWavesurferRef.current = WaveSurfer.create({
        container: recordWaveformRef.current,
        waveColor: "#a4b0be",
        progressColor: "#57606f",
        cursorColor: "#ff4757",
      });
      recordWavesurferRef.current.load(recordingAudioURL);
    }
  }, [recordingAudioURL]);

  // ----------------------------------------------------------------
  // 11) Forced Alignment Calls
  // ----------------------------------------------------------------
  // Reuse ttsWavBlob / userWavBlob from above, plus user-provided transcript
  const forcedAlignAi = async () => {
    if (!ttsWavBlob) {
      alert("No AI WAV file found. Please generate TTS first!");
      return;
    }
    if (!forcedAlignmentTranscript.trim()) {
      alert("Please enter transcript text to align.");
      return;
    }
    const formData = new FormData();
    formData.append("audio", ttsWavBlob, "tts.wav");
    formData.append("transcript", forcedAlignmentTranscript);

    try {
      const response = await fetch("/api/forced_alignment", {
        method: "POST",
        body: formData,
      });
      if (!response.ok) {
        throw new Error(`Server responded with ${response.status}`);
      }
      const alignment = await response.json();
      setAiAlignmentData(alignment);
    } catch (error) {
      console.error("Error during AI forced alignment:", error);
      alert("Failed to align AI audio.");
    }
  };

  const forcedAlignUser = async () => {
    if (!userWavBlob) {
      alert("No user WAV file found. Please record yourself first!");
      return;
    }
    if (!forcedAlignmentTranscript.trim()) {
      alert("Please enter transcript text to align.");
      return;
    }
    const formData = new FormData();
    formData.append("audio", userWavBlob, "recording.wav");
    formData.append("transcript", forcedAlignmentTranscript);

    try {
      const response = await fetch("/api/forced_alignment", {
        method: "POST",
        body: formData,
      });
      if (!response.ok) {
        throw new Error(`Server responded with ${response.status}`);
      }
      const alignment = await response.json();
      setUserAlignmentData(alignment);
    } catch (error) {
      console.error("Error during user forced alignment:", error);
      alert("Failed to align user audio. See console for details.");
    }
  };

  // ----------------------------------------------------------------
  // 12) Chart Data Setup (Existing)
  // ----------------------------------------------------------------
  const aiPitchData = {
    labels: aiPitchAnalysis.map((p) => p.time.toFixed(2)),
    datasets: [
      {
        label: "AI Pitch (Hz)",
        data: aiPitchAnalysis.map((p) => p.frequency),
        borderColor: "#1e90ff",
        backgroundColor: "rgba(30,144,255,0.2)",
        borderWidth: 2,
        fill: false,
        pointRadius: 0,
        lineTension: 0.1,
      },
    ],
  };

  const userPitchData = {
    labels: userPitchAnalysis.map((p) => p.time.toFixed(2)),
    datasets: [
      {
        label: "My Pitch (Hz)",
        data: userPitchAnalysis.map((p) => p.frequency),
        borderColor: "#ff4757",
        backgroundColor: "rgba(255,71,87,0.2)",
        borderWidth: 2,
        fill: false,
        pointRadius: 0,
        lineTension: 0.1,
      },
    ],
  };

  const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    scales: {
      x: { title: { display: true, text: "Time (s)" } },
      y: {
        title: { display: true, text: "Frequency (Hz)" },
        min: 50,
        max: 500,
      },
    },
  };

  // ----------------------------------------------------------------
  // 13) Render
  // ----------------------------------------------------------------
  return (
    <main className="flex flex-col min-h-screen bg-textWhite">
      {/* Header Section */}
      <header className="w-full bg-textWhite py-4">
        <div className="flex items-center justify-between max-w-full px-6">
          <div className="text-xl font-bold text-textBlack">
            English Pronunciation Improvement
          </div>
          <nav className="flex items-center space-x-6">
            <button className="px-4 py-2 rounded-lg bg-textWhite text-textBlack font-semibold border">
              Sign In
            </button>
            <button className="px-4 py-2 rounded-lg bg-brightYellow text-textBlack font-semibold">
              Sign Up
            </button>
          </nav>
        </div>
      </header>

      {/* Hero Section */}
      <section className="relative w-full bg-textWhite py-20 overflow-hidden">
        <div className="absolute inset-0 z-0">
          <div className="absolute -top-10 -left-20 bg-brightYellow rounded-full h-64 w-64 opacity-70"></div>
          <div className="absolute top-30 right-10 bg-turquoise rounded-full h-48 w-48 opacity-70"></div>
          <div className="absolute -top-20 -left-20 bg-turquoise rounded-full h-20 w-20 opacity-70"></div>
        </div>

        <div className="relative z-10 flex flex-col lg:flex-row items-center justify-center mx-auto max-w-screen-xl px-6">
          <div className="max-w-xl space-y-6">
            <h1 className="text-5xl lg:text-6xl font-bold text-textBlack leading-tight">
              Record, Analyze, and Improve Your Pronunciation.
            </h1>
            <p className="text-lg text-textBlack">
              Compare your pronunciation to a native one using AI-powered tools.
            </p>
            <div className="flex flex-col space-y-4">
              {/* API Key Input */}
              <input
                type="text"
                placeholder="Enter your OpenAI API Key"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                className="px-4 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-brightYellow w-full"
              />

              {/* Text to Convert to Speech */}
              <textarea
                rows="4"
                placeholder="Enter text to convert to speech"
                value={text}
                onChange={(e) => setText(e.target.value)}
                className="px-4 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-brightYellow w-full"
              />

              {/* Generate Audio Button */}
              <button
                onClick={handleGenerateAudio}
                disabled={loading}
                className={`px-6 py-2 rounded-lg text-textWhite ${
                  loading
                    ? "bg-darkGray cursor-not-allowed"
                    : "bg-brightYellow hover:bg-textBlack"
                }`}
              >
                {loading ? "Generating..." : "Generate Audio"}
              </button>
            </div>
          </div>

          <div className="relative mt-8 lg:mt-0">
            <img
              src="/psycholing.png"
              alt="Hero"
              className="w-[30rem] h-auto rounded-lg"
              style={{
                backgroundColor: "transparent",
                position: "relative",
                top: "5rem",
                left: "5rem",
              }}
            />
          </div>
        </div>
      </section>

      {/* Divider Line */}
      <div className="w-full border-t border-gray-300 my-6"></div>

      {/* Recording Section */}
      <section className="max-w-screen-xl mx-auto px-6 py-12">
        <h2 className="text-2xl font-semibold text-center mb-6 text-textBlack">
          Record Yourself
        </h2>
        <div className="flex items-center justify-center gap-4">
          <button
            onClick={handleStartRecording}
            disabled={recording}
            className={`flex items-center px-6 py-2 rounded-full font-semibold text-textWhite gap-2 ${
              recording
                ? "bg-darkGray cursor-not-allowed"
                : "bg-brightYellow hover:bg-textBlack"
            }`}
          >
            Start Recording
          </button>
          <button
            onClick={handleStopRecording}
            disabled={!recording}
            className={`flex items-center px-6 py-2 rounded-full font-semibold text-textWhite gap-2 ${
              !recording
                ? "bg-darkGray cursor-not-allowed"
                : "bg-brightYellow hover:bg-textBlack"
            }`}
          >
            Stop Recording
          </button>
        </div>
      </section>

      {/* Divider Line */}
      <div className="w-full border-t border-gray-300 my-6"></div>

      {/* Waveforms Section */}
      {(ttsAudioURL || recordingAudioURL) && (
        <section className="max-w-screen-lg mx-auto px-6 py-12">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 items-start">
            {/* AI Waveform & Audio */}
            {ttsAudioURL && (
              <div className="bg-white rounded-lg p-6 border border-gray-300">
                <h2 className="text-xl font-semibold text-center text-textBlack mb-4">
                  AI Waveform
                </h2>
                <div
                  ref={ttsWaveformRef}
                  className="h-32 w-[400px] bg-lightGray rounded-lg"
                />
                <div className="mt-4">
                  <audio
                    controls
                    src={ttsAudioURL}
                    className="w-[400px] rounded-lg border shadow-md focus:outline-none focus:ring-2 focus:ring-brightYellow"
                  />
                </div>
              </div>
            )}

            {/* User Waveform & Audio */}
            {recordingAudioURL && (
              <div className="bg-white rounded-lg p-6 border border-gray-300">
                <h2 className="text-xl font-semibold text-center text-textBlack mb-4">
                  My Waveform
                </h2>
                <div
                  ref={recordWaveformRef}
                  className="h-32 w-[400px] bg-lightGray rounded-lg"
                />
                <div className="mt-4">
                  <audio
                    controls
                    src={recordingAudioURL}
                    className="w-[400px] rounded-lg border shadow-md focus:outline-none focus:ring-2 focus:ring-brightYellow"
                  />
                </div>
              </div>
            )}
          </div>
        </section>
      )}

      {/* Pitch Analysis Section */}
      {(aiPitchAnalysis.length > 0 || userPitchAnalysis.length > 0) && (
        <section className="max-w-screen-lg mx-auto px-6 py-12">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 items-start">
            {/* AI Pitch */}
            {aiPitchAnalysis.length > 0 && (
              <div className="bg-white rounded-lg p-6 border border-gray-300">
                <h2 className="text-xl font-semibold text-center text-textBlack mb-4">
                  AI Pitch Analysis
                </h2>
                <div
                  style={{ position: "relative", height: "200px", width: "400px" }}
                  className="relative w-full"
                >
                  <Line data={aiPitchData} options={chartOptions} />
                </div>
              </div>
            )}

            {/* User Pitch */}
            {userPitchAnalysis.length > 0 && (
              <div className="bg-white rounded-lg p-6 border border-gray-300">
                <h2 className="text-xl font-semibold text-center text-textBlack mb-4">
                  My Pitch Analysis
                </h2>
                <div
                  style={{ position: "relative", height: "200px", width: "400px" }}
                  className="relative w-full"
                >
                  <Line data={userPitchData} options={chartOptions} />
                </div>
              </div>
            )}
          </div>
        </section>
      )}

      {/* Forced Alignment Section */}
      <section className="max-w-screen-lg mx-auto px-6 py-12">
        <h2 className="text-2xl font-semibold text-center mb-6 text-textBlack">
          Forced Alignment
        </h2>

        {/* Transcript Input */}
        <div className="flex flex-col items-center space-y-4">
          <textarea
            rows="3"
            placeholder="Enter transcript here..."
            value={forcedAlignmentTranscript}
            onChange={(e) => setForcedAlignmentTranscript(e.target.value)}
            className="border rounded p-2 w-full max-w-xl"
          />

          {/* Buttons to align TTS or user audio */}
          <div className="flex space-x-4">
            <button
              onClick={forcedAlignAi}
              className="bg-brightYellow text-textBlack px-4 py-2 rounded"
            >
              Align TTS
            </button>
            <button
              onClick={forcedAlignUser}
              className="bg-brightYellow text-textBlack px-4 py-2 rounded"
            >
              Align User Recording
            </button>
          </div>
        </div>

        {/* Display AI alignment result */}
        {aiAlignmentData.length > 0 && (
          <div className="mt-6">
            <h3 className="text-xl font-semibold mb-2">AI Alignment Result</h3>
            {aiAlignmentData.map((item, index) => (
              <div key={index} className="border-b pb-2 mb-2">
                <p>Token: {item.token}</p>
                <p>Start Frame: {item.start_frame}</p>
                <p>End Frame: {item.end_frame}</p>
                <p>Score: {item.score}</p>
              </div>
            ))}
          </div>
        )}

        {/* Display user alignment result */}
        {userAlignmentData.length > 0 && (
          <div className="mt-6">
            <h3 className="text-xl font-semibold mb-2">User Alignment Result</h3>
            {userAlignmentData.map((item, index) => (
              <div key={index} className="border-b pb-2 mb-2">
                <p>Token: {item.token}</p>
                <p>Start Frame: {item.start_frame}</p>
                <p>End Frame: {item.end_frame}</p>
                <p>Score: {item.score}</p>
              </div>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}

export default App;
