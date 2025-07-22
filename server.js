const express = require("express");
const { createServer } = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

const app = express();
app.use(cors());
const server = createServer(app);

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

// Map rooms to a Set of { id: socket.id, username: string } objects
const rooms = new Map(); // Map: roomId -> Set of { id, username }

io.on("connection", (socket) => {
  console.log(`🔌 ${socket.id} connected`);

  // Store username directly on the socket instance for easy access
  socket.data.username = "";

  socket.on("join_random", ({ username }) => {
    let assignedRoom = null;

    // Find an available room with exactly one user
    for (let [roomId, usersSet] of rooms.entries()) {
      if (usersSet.size === 1) {
        assignedRoom = roomId;
        break;
      }
    }

    if (!assignedRoom) {
      // Create a new room if no available rooms with 1 user
      assignedRoom = `room_${Math.random().toString(36).substr(2, 6)}`;
      rooms.set(assignedRoom, new Set()); // Initialize with an empty Set
    }

    socket.join(assignedRoom);
    socket.data.username = username; // Assign username to socket.data

    const currentRoomUsers = rooms.get(assignedRoom);
    if (currentRoomUsers) {
      currentRoomUsers.add({ id: socket.id, username: username });
    } else {
      // This should ideally not happen if rooms.set is always called
      console.error(`Room ${assignedRoom} not found in rooms Map.`);
      rooms.set(assignedRoom, new Set([{ id: socket.id, username: username }]));
    }

    const roomSize = io.sockets.adapter.rooms.get(assignedRoom)?.size || 0;
    console.log(
      `${socket.id} (${username}) joined ${assignedRoom} (${roomSize} inside)`
    );

    // Get usernames for the current room to send to client
    const usernamesInRoom = Array.from(rooms.get(assignedRoom)).map((u) => ({
      id: u.id,
      username: u.username,
    }));

    // Send assigned room back to client along with usernames in that room
    socket.emit("room_assigned", {
      room: assignedRoom,
      usernames: usernamesInRoom,
    });

    // Notify all clients in the room about the updated list of usernames
    io.to(assignedRoom).emit("update_usernames", {
      usernames: usernamesInRoom,
    });

    // If room is now full (2 users), notify both to start WebRTC process
    if (roomSize === 2) {
      // Find the two users in the room
      const [user1, user2] = Array.from(currentRoomUsers);
      // Send "ready" to each user, informing them of their peer's username
      io.to(user1.id).emit("ready", { peerUsername: user2.username });
      io.to(user2.id).emit("ready", { peerUsername: user1.username });
    }
  });

  socket.on("offer", ({ room, sdp, offerSenderUsername }) => {
    socket.to(room).emit("offer", { sdp, offerSenderUsername });
  });
  socket.on("answer", ({ room, sdp, answerSenderUsername }) => {
    socket.to(room).emit("answer", { sdp, answerSenderUsername });
  });
  socket.on("ice", ({ room, candidate }) =>
    socket.to(room).emit("ice", candidate)
  );

  socket.on("chat_message", ({ room, message, senderUsername, senderId }) => {
    // Broadcast message to everyone in the room except the sender
    socket.to(room).emit("chat_message", { senderUsername, message, senderId });
    console.log(
      `[${room}] Message from ${senderUsername} (${senderId}): ${message}`
    );
  });

  socket.on("disconnecting", () => {
    const roomsSocketIsIn = Array.from(socket.rooms).filter(
      (r) => r !== socket.id
    ); // Get rooms the socket is in (excluding its own ID room)
    roomsSocketIsIn.forEach((roomId) => {
      const currentRoomUsers = rooms.get(roomId);
      if (currentRoomUsers) {
        // Remove the disconnected user from the room's user set
        const disconnectedUser = {
          id: socket.id,
          username: socket.data.username,
        };
        currentRoomUsers.delete(disconnectedUser); // Note: Set.delete uses referential equality for objects

        // Filter out by ID for reliable deletion of objects from Set
        const updatedUsersSet = new Set(
          Array.from(currentRoomUsers).filter((u) => u.id !== socket.id)
        );
        rooms.set(roomId, updatedUsersSet); // Update the map with the new set

        // If a peer remains, notify them
        if (updatedUsersSet.size === 1) {
          const remainingUser = Array.from(updatedUsersSet)[0];
          io.to(remainingUser.id).emit("peer_disconnected");
          // Optionally, add the room back to available rooms if it was full
        } else if (updatedUsersSet.size === 0) {
          // If room is now empty, delete it from the rooms map
          rooms.delete(roomId);
        }

        // Notify remaining users about the updated username list
        io.to(roomId).emit("update_usernames", {
          usernames: Array.from(updatedUsersSet).map((u) => ({
            id: u.id,
            username: u.username,
          })),
        });
      }
    });
  });

  socket.on("disconnect", () => {
    console.log(`❌ ${socket.id} disconnected`);
  });
});

server.listen(3001, () => console.log("🚀 signalling server running on :3001"));
