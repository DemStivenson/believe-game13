const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname)));

// ============ ХРАНИЛИЩЕ ============
const lobbies = new Map(); // code -> Lobby
const sockets = new Map(); // socketId -> { lobbyCode, playerId }

// ============ УТИЛИТЫ ============
function generateCode() {
    let code;
    do { code = Math.floor(1000 + Math.random() * 9000).toString(); }
    while (lobbies.has(code));
    return code;
}

function shuffleArray(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

function createDeck() {
    const deck = [];
    for (let i = 0; i < 6; i++) deck.push({ type: 'truth' });
    for (let i = 0; i < 6; i++) deck.push({ type: 'lie' });
    return shuffleArray(deck);
}

// ============ КЛАССЫ ============
class Lobby {
    constructor(code, host) {
        this.code = code;
        this.players = [host];
        this.state = 'lobby'; // lobby | playing | finished
        this.gameState = null;
    }

    addPlayer(player) {
        if (this.players.length >= 4) return false;
        this.players.push(player);
        return true;
    }

    removePlayer(playerId) {
        this.players = this.players.filter(p => p.id !== playerId);
        return this.players.length === 0;
    }

    startGame() {
        if (this.players.length < 2) return false;
        this.state = 'playing';
        this.gameState = {
            deck: createDeck(),
            currentCardIndex: 0,
            currentPlayerIndex: 0,
            phase: 'draw', // draw | statement | vote | result
            scores: 0,
            currentStatement: '',
            votes: {}, // playerId -> 'believe' | 'not_believe'
            history: []
        };
        return true;
    }

    getStateForPlayer(playerId) {
        const base = {
            code: this.code,
            players: this.players.map(p => ({ id: p.id, name: p.name, avatar: p.avatar })),
            state: this.state
        };

        if (this.state === 'playing' && this.gameState) {
            const gs = this.gameState;
            const currentPlayer = this.players[gs.currentPlayerIndex];
            const isMyTurn = currentPlayer.id === playerId;
            const card = gs.deck[gs.currentCardIndex];

            base.game = {
                phase: gs.phase,
                scores: gs.scores,
                currentPlayerIndex: gs.currentPlayerIndex,
                currentPlayerName: currentPlayer.name,
                isMyTurn,
                // Карта видна только активному игроку в фазе draw/statement
                card: (isMyTurn && (gs.phase === 'draw' || gs.phase === 'statement')) ? card : null,
                currentStatement: gs.phase !== 'draw' ? gs.currentStatement : null,
                myVote: gs.votes[playerId] || null,
                totalVotes: Object.keys(gs.votes).length,
                totalVoters: this.players.length - 1, // активный игрок не голосует
                history: gs.history,
                totalRounds: gs.deck.length,
                currentRound: gs.currentCardIndex + (gs.phase === 'draw' ? 0 : 1)
            };
        }

        return base;
    }
}

// ============ СОБЫТИЯ ============
io.on('connection', (socket) => {
    console.log('Подключился:', socket.id);

    socket.on('create_lobby', ({ name, avatar }) => {
        const code = generateCode();
        const player = { id: socket.id, name, avatar };
        const lobby = new Lobby(code, player);
        lobbies.set(code, lobby);
        sockets.set(socket.id, { lobbyCode: code, playerId: socket.id });
        socket.emit('lobby_joined', lobby.getStateForPlayer(socket.id));
    });

    socket.on('join_lobby', ({ code, name, avatar }) => {
        const lobby = lobbies.get(code);
        if (!lobby) return socket.emit('error_msg', 'Лобби не найдено');
        if (lobby.state !== 'lobby') return socket.emit('error_msg', 'Игра уже началась');
        if (lobby.players.length >= 4) return socket.emit('error_msg', 'Лобби полное');

        const player = { id: socket.id, name, avatar };
        lobby.addPlayer(player);
        sockets.set(socket.id, { lobbyCode: code, playerId: socket.id });

        broadcastLobby(code);
        socket.emit('lobby_joined', lobby.getStateForPlayer(socket.id));
    });

    socket.on('start_game', () => {
        const info = sockets.get(socket.id);
        if (!info) return;
        const lobby = lobbies.get(info.lobbyCode);
        if (!lobby || lobby.players[0].id !== socket.id) return;
        if (lobby.players.length < 2) return socket.emit('error_msg', 'Нужно минимум 2 игрока');

        if (lobby.startGame()) {
            broadcastLobby(info.lobbyCode);
        }
    });

    socket.on('draw_card', () => {
        const info = sockets.get(socket.id);
        if (!info) return;
        const lobby = lobbies.get(info.lobbyCode);
        if (!lobby || lobby.state !== 'playing') return;
        const gs = lobby.gameState;
        if (lobby.players[gs.currentPlayerIndex].id !== socket.id) return;
        if (gs.phase !== 'draw') return;

        gs.phase = 'statement';
        broadcastLobby(info.lobbyCode);
    });

    socket.on('submit_statement', ({ text }) => {
        const info = sockets.get(socket.id);
        if (!info) return;
        const lobby = lobbies.get(info.lobbyCode);
        if (!lobby || lobby.state !== 'playing') return;
        const gs = lobby.gameState;
        if (lobby.players[gs.currentPlayerIndex].id !== socket.id) return;
        if (gs.phase !== 'statement') return;
        if (!text || text.trim().length === 0) return;

        gs.currentStatement = text.trim();
        gs.phase = 'vote';
        gs.votes = {};
        broadcastLobby(info.lobbyCode);
    });

    socket.on('vote', ({ choice }) => {
        const info = sockets.get(socket.id);
        if (!info) return;
        const lobby = lobbies.get(info.lobbyCode);
        if (!lobby || lobby.state !== 'playing') return;
        const gs = lobby.gameState;
        if (gs.phase !== 'vote') return;
        const activePlayer = lobby.players[gs.currentPlayerIndex];
        if (activePlayer.id === socket.id) return;
        if (gs.votes[socket.id]) return;
        if (choice !== 'believe' && choice !== 'not_believe') return;

        gs.votes[socket.id] = choice;

        const totalVoters = lobby.players.length - 1;
        if (Object.keys(gs.votes).length === totalVoters) {
            resolveTurn(lobby);
        }
        broadcastLobby(info.lobbyCode);
    });

    socket.on('next_turn', () => {
        const info = sockets.get(socket.id);
        if (!info) return;
        const lobby = lobbies.get(info.lobbyCode);
        if (!lobby || lobby.state !== 'playing') return;
        const gs = lobby.gameState;
        if (gs.phase !== 'result') return;
        if (lobby.players[gs.currentPlayerIndex].id !== socket.id) return;

        gs.currentCardIndex++;
        gs.currentPlayerIndex = (gs.currentPlayerIndex + 1) % lobby.players.length;
        gs.phase = 'draw';
        gs.currentStatement = '';
        gs.votes = {};

        if (gs.currentCardIndex >= gs.deck.length || gs.scores >= 8) {
            lobby.state = 'finished';
        }

        broadcastLobby(info.lobbyCode);
    });

    socket.on('play_again', () => {
        const info = sockets.get(socket.id);
        if (!info) return;
        const lobby = lobbies.get(info.lobbyCode);
        if (!lobby || lobby.players[0].id !== socket.id) return;

        lobby.state = 'lobby';
        lobby.gameState = null;
        broadcastLobby(info.lobbyCode);
    });

    socket.on('leave_lobby', () => handleDisconnect(socket));

    socket.on('disconnect', () => handleDisconnect(socket));
});

function resolveTurn(lobby) {
    const gs = lobby.gameState;
    const card = gs.deck[gs.currentCardIndex];
    const voters = Object.keys(gs.votes);
    const totalVoters = voters.length;

    // Что должны были голосовать:
    // если карта 'truth' → правильно 'believe'
    // если карта 'lie' → правильно 'not_believe'
    const correctChoice = card.type === 'truth' ? 'believe' : 'not_believe';
    const correctVotes = voters.filter(pid => gs.votes[pid] === correctChoice).length;

    let pointsEarned = 0;
    let resultText = '';
    if (correctVotes === totalVoters) {
        pointsEarned = 2;
        resultText = 'Идеально! Все угадали!';
    } else if (correctVotes > totalVoters / 2) {
        pointsEarned = 1;
        resultText = 'Большинство угадало!';
    } else {
        pointsEarned = 0;
        resultText = 'Большинство ошиблось!';
    }

    gs.scores += pointsEarned;
    gs.phase = 'result';
    gs.lastResult = {
        cardType: card.type,
        correctChoice,
        correctVotes,
        totalVoters,
        pointsEarned,
        resultText,
        votes: { ...gs.votes }
    };
    gs.history.push({
        player: lobby.players[gs.currentPlayerIndex].name,
        statement: gs.currentStatement,
        cardType: card.type,
        pointsEarned
    });
}

function handleDisconnect(socket) {
    const info = sockets.get(socket.id);
    if (!info) return;
    const lobby = lobbies.get(info.lobbyCode);
    if (lobby) {
        const empty = lobby.removePlayer(socket.id);
        if (empty) {
            lobbies.delete(info.lobbyCode);
        } else {
            broadcastLobby(info.lobbyCode);
        }
    }
    sockets.delete(socket.id);
}

function broadcastLobby(code) {
    const lobby = lobbies.get(code);
    if (!lobby) return;
    lobby.players.forEach(p => {
        io.to(p.id).emit('lobby_updated', lobby.getStateForPlayer(p.id));
    });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Сервер запущен на http://localhost:${PORT}`);
});