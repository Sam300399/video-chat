import { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
import "./App.css";

const socket = io("http://localhost:3001");

export default function App() {
  const [username, setUsername] = useState(""); // new username state
  const [roomId, setRoomId] = useState("");
  const [joined, setJoined] = useState(false);
  const [message, setMessage] = useState("");
  const [chatMessages, setChatMessages] = useState([]);
  const [peerUsername, setPeerUsername] = useState(""); // store peer's username
  const [isRoomFull, setIsRoomFull] = useState(false); // To enable/disable chat

  const localVideo = useRef(null);
  const remoteVideo = useRef(null);
  const pcRef = useRef(null);
  const chatMessagesRef = useRef(null);

  function cleanupPC() {
    if (pcRef.current) {
      pcRef.current.close();
      pcRef.current = null;
    }
    if (localVideo.current) localVideo.current.srcObject = null;
    if (remoteVideo.current) remoteVideo.current.srcObject = null;
    setChatMessages([]);
    setPeerUsername("");
    setIsRoomFull(false); // Reset room full status on cleanup
  }

  async function startJoin() {
    if (!username.trim()) {
      alert("Please enter a username");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true,
      });
      localVideo.current.srcObject = stream;

      // Emit username along with join request
      socket.emit("join_random", { username: username.trim() });
    } catch (err) {
      console.error(err);
      alert("Could not access camera/microphone");
    }
  }

  useEffect(() => {
    function handleRoomAssigned({ room, usernames }) {
      setRoomId(room);
      setJoined(true);

      // Determine username of peer (the other user in room)
      // usernames array now contains {id, username} objects from server
      const currentSocketId = socket.id;
      const peer = usernames.find((u) => u.id !== currentSocketId);
      setPeerUsername(peer ? peer.username : "Waiting for peer...");
      setIsRoomFull(usernames.length === 2); // Set room status based on initial join

      const pc = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      });
      pcRef.current = pc;

      pc.onicecandidate = (e) => {
        if (e.candidate) {
          socket.emit("ice", { room, candidate: e.candidate });
        }
      };

      pc.ontrack = (e) => {
        remoteVideo.current.srcObject = e.streams[0];
      };

      if (localVideo.current && localVideo.current.srcObject) {
        localVideo.current.srcObject
          .getTracks()
          .forEach((track) => pc.addTrack(track, localVideo.current.srcObject));
      }
    }

    socket.on("room_assigned", handleRoomAssigned);
    return () => socket.off("room_assigned", handleRoomAssigned);
  }, [username]); // Added username to dependency array as it's used in handleRoomAssigned

  useEffect(() => {
    if (!joined || !roomId) return;

    socket.on("ready", async ({ peerUsername: remotePeerUsername }) => {
      const pc = pcRef.current;
      if (!pc) return;

      // When "ready" is received, it means there are 2 people and connection can begin
      setPeerUsername(remotePeerUsername);
      setIsRoomFull(true);

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit("offer", {
        room: roomId,
        sdp: offer,
        offerSenderUsername: username,
      }); // Send username with offer
    });

    socket.on("offer", async ({ sdp, offerSenderUsername }) => {
      const pc = pcRef.current;
      if (!pc) return;

      setPeerUsername(offerSenderUsername);
      setIsRoomFull(true);

      await pc.setRemoteDescription(sdp);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit("answer", {
        room: roomId,
        sdp: answer,
        answerSenderUsername: username,
      }); // Send username with answer
    });

    socket.on("answer", async ({ sdp, answerSenderUsername }) => {
      const pc = pcRef.current;
      if (!pc) return;

      setPeerUsername(answerSenderUsername);
      setIsRoomFull(true);

      await pc.setRemoteDescription(sdp);
    });

    socket.on("ice", async (candidate) => {
      try {
        await pcRef.current?.addIceCandidate(candidate);
      } catch (err) {
        console.error("Error adding ice", err);
      }
    });

    socket.on("peer_disconnected", () => {
      alert("Peer disconnected. Searching for a new partner...");
      cleanupPC();
      setJoined(false); // Reset joined state
      setRoomId("");
      setPeerUsername("");
      setIsRoomFull(false); // Reset room status
      startJoin(); // Automatically re-join a new room
    });

    // Receive updated usernames in room (e.g., when peer joins or leaves)
    socket.on("update_usernames", ({ usernames }) => {
      // Find the peer's username from the updated list
      const currentSocketId = socket.id;
      const peer = usernames.find((u) => u.id !== currentSocketId);
      setPeerUsername(peer ? peer.username : "Waiting for peer...");
      setIsRoomFull(usernames.length === 2); // Update room full status
    });

    socket.on("chat_message", ({ senderUsername, message }) => {
      setChatMessages((prevMessages) => [
        ...prevMessages,
        { senderUsername, message },
      ]);
    });

    return () => {
      socket.off("ready");
      socket.off("offer");
      socket.off("answer");
      socket.off("ice");
      socket.off("peer_disconnected");
      socket.off("chat_message");
      socket.off("update_usernames");
    };
  }, [joined, roomId, username]);

  useEffect(() => {
    if (chatMessagesRef.current) {
      chatMessagesRef.current.scrollTop = chatMessagesRef.current.scrollHeight;
    }
  }, [chatMessages]);

  const joinRoom = () => {
    startJoin();
  };

  const skipRoom = () => {
    // Renamed from leaveRoom
    cleanupPC(); // Clean up current connection
    setJoined(false);
    setRoomId("");
    setPeerUsername("");
    setIsRoomFull(false); // Ensure chat is disabled while searching
    setChatMessages([]); // Clear chat for new room
    // No socket.disconnect() then reconnect here, as startJoin will re-emit 'join_random'
    // directly. This makes the transition faster.
    startJoin(); // Immediately try to join a new random room
  };

  const sendMessage = (e) => {
    e.preventDefault();
    if (message.trim() && joined && roomId && isRoomFull) {
      // Chat enabled only when room is full
      socket.emit("chat_message", {
        room: roomId,
        message: message.trim(),
        senderUsername: username,
        senderId: socket.id, // Include senderId for client-side message display logic
      });

      // Add own message to chatMessages array immediately
      setChatMessages((prevMessages) => [
        ...prevMessages,
        {
          senderUsername: username,
          message: message.trim(),
          senderId: socket.id,
        },
      ]);
      setMessage("");
    }
  };

  return (
    <div className="body">
      <h1>Video Chat</h1>

      {!joined && (
        <div className="join-container">
          <input
            type="text"
            placeholder="Enter your username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="username-input"
            autoComplete="off"
          />
          <button className="buttonJoin" onClick={joinRoom}>
            Join Random Room
          </button>
        </div>
      )}

      {joined && (
        <button className="skip-button" onClick={skipRoom}>
          {" "}
          {/* Renamed button */}
          SKIP
        </button>
      )}

      <div className="video-and-info-wrapper">
        {" "}
        {/* New wrapper for videos and info */}
        {joined && <h4 className="room-id">Room ID: {roomId}</h4>}
        {joined && <p className="peer-info">Peer: {peerUsername}</p>}
        <div className="video-grid">
          {" "}
          {/* Renamed from 'grid' to 'video-grid' for clarity */}
          <div className="video-wrapper">
            <video
              ref={localVideo}
              autoPlay
              playsInline
              muted
              className="video-player local-video"
            />
          </div>
          <div className="video-wrapper">
            <video
              ref={remoteVideo}
              autoPlay
              playsInline
              className="video-player remote-video"
            />
          </div>
        </div>
      </div>

      {joined && (
        <div className="chat-container">
          <h3>Chat</h3>
          <div className="chat-messages" ref={chatMessagesRef}>
            {chatMessages.map((msg, index) => (
              <p
                key={index}
                className={
                  msg.senderUsername === username
                    ? "my-message"
                    : "their-message"
                }
              >
                <strong>
                  {msg.senderUsername === username ? "You" : msg.senderUsername}
                  :
                </strong>{" "}
                {msg.message}
              </p>
            ))}
          </div>
          <form onSubmit={sendMessage} className="chat-input-form">
            <input
              type="text"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder={
                isRoomFull
                  ? "Type your message..."
                  : "Waiting for peer to join to chat..."
              }
              className="chat-input"
              autoComplete="off"
              disabled={!isRoomFull}
            />
            <button
              type="submit"
              className="send-button"
              disabled={!isRoomFull}
            >
              {" "}
              {/* Disable send button if room not full */}
              Send
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
