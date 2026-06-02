import { useState } from "react";
import RelayShogiApp from "./games/relay/RelayShogiApp";
import ThreeShogiApp from "./games/three/ThreeShogiApp";

type GameMode = "menu" | "relay" | "three";

export default function App() {
  const [mode, setMode] = useState<GameMode>("menu");

  if (mode === "relay") return <RelayShogiApp />;
  if (mode === "three") return <ThreeShogiApp />;

  return (
    <div style={{ padding: 24 }}>
      <h1>将棋アクティビティ</h1>
      <button onClick={() => setMode("relay")}>リレー将棋</button>
      <button onClick={() => setMode("three")}>三人将棋</button>
    </div>
  );
}