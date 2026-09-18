// Временная заглушка для локальной разработки, чтобы кнопка работала без интернета
/*if (!window.Telegram) {
  window.Telegram = {
    WebApp: {
      ready: () => console.log("TG Ready"),
      expand: () => console.log("TG Expanded")
    }
  };
}*/
gsap.registerPlugin(Draggable);

const telegram = window.Telegram?.WebApp;

if (telegram) {
  telegram.ready();
  telegram.expand();
}

const dealButton = document.getElementById("deal-btn");
const playerHand = document.getElementById("player-hand");
const opponentHand = document.getElementById("opponent-hand"); // Рука бота
const deck = document.getElementById("deck");

const MAX_CARDS_IN_HAND = 6;
const MAX_ATTACKS_ON_TABLE = 6; // максимум атакующих карт на столе (6 пар = 12 карт)
let deckSize = 36; // 36 или 24 — режим игры

// Переменные для стартового меню и профиля бота
const startMenu = document.getElementById("start-menu");
const playButton = document.getElementById("play-btn");
const opponentProfile = document.getElementById("opponent-profile");

// ===== Настройки: размер колоды + Подкидной / Переводной =====
const settingsBtn = document.getElementById("settings-btn");
const settingsModal = document.getElementById("settings-modal");
const settingsClose = document.getElementById("settings-close");
const settingsSaveBtn = document.getElementById("settings-save-btn");

// true = модалка открыта из «Тренировка» (кнопка «Начать»), false = из шестерёнки («Сохранить»)
let isMenuTrainingOpen = false;

// true = сетевой матч (ожидание / ход живого соперника); false = тренировка vs бот Алина
let isOnlineMatch = false;
// Готовность к старту сетевой партии
let isPlayerReady = false;
let isOpponentReady = false;
let hasOpponentConnected = false;
// Сетевое лобби (Socket.IO)
let networkTables = []; // список с сервера
let myTableId = null;
let myNetworkRole = null; // 'host' | 'guest'
let onlineJoinTimer = null;
let onlineReadyTimer = null;
/** Имя соперника, пришедшее до окончания анимации входа на стол */
let pendingOpponentName = null;
const PLAYER_DISPLAY_NAME = "Николай";

// ===== ДЕМО-ВИЗИТКА: только тренировка с ботом =====
const DEMO_ONLY_TRAINING = true;



// Socket.IO
const socket = typeof io !== "undefined" ? io({ transports: ["websocket", "polling"] }) : null;
if (socket) {
  socket.on("connect", () => {
    console.log("[net] connected", socket.id);
    socket.emit("player:setName", PLAYER_DISPLAY_NAME);
  });
  socket.on("disconnect", () => console.log("[net] disconnected"));
  socket.on("lobby:tables", (list) => {
    networkTables = Array.isArray(list) ? list : [];
    if (lobbyModal && lobbyModal.style.display !== "none") renderLobbyTables();
  });
  socket.on("table:opponentJoined", (data) => {
    console.log("[net] opponent joined", data);
    // Хост: гость зашёл
    queueOpponentJoined(data?.opponentName || "Игрок");
  });
  socket.on("table:joined", (data) => {
    console.log("[net] joined table", data);
    myTableId = data.tableId;
    myNetworkRole = data.role || "guest";
    isOnlineMatch = true;
    if (data.deckSize) deckSize = data.deckSize;
    if (typeof data.isPerevodnoy === "boolean") {
      isPerevodnoy = data.isPerevodnoy;
      isPodkidnoy = data.isPodkidnoy;
    }
    const hostName = data.opponentName || "Хост";
    // Гость: жёстко входим на стол и СРАЗУ показываем ГОТОВ (без гонок GSAP)
    enterOnlineTableAsGuest(hostName);
  });
  socket.on("table:playerReady", (data) => {
    console.log("[net] player ready", data);
    if (data?.role && data.role !== myNetworkRole) {
      onOpponentReady();
    }
  });
  socket.on("game:start", (payload) => {
    console.log("[net] game start", payload);
    applyNetworkGameStart(payload);
  });
  socket.on("table:opponentLeft", () => {
    console.log("[net] opponent left");
    hasOpponentConnected = false;
    isOpponentReady = false;
    isPlayerReady = false;
    setOpponentWaitingUI();
    hideActionButton();
  });
  socket.on("table:closed", () => {
    console.log("[net] table closed");
    alert("Стол закрыт (хост вышел).");
    goToMainMenu();
  });
  socket.on("game:move", (msg) => {
    console.log("[net] remote move", msg);
    if (!msg) return;
    const move = msg.move || msg;
    const from = msg.from || null;
    applyRemoteMove(move, from);
  });
  socket.on("game:round_ended", (payload) => {
    console.log("[net] round ended", payload);
    applyNetworkRoundEnded(payload);
  });
  socket.on("game:move_rejected", (data) => {
    console.warn("[net] move rejected", data);
  });
}

function applyNetworkGameStart(payload) {
  if (!payload) return;
  document.querySelector(".table")?.classList.add("game-active");
  isOnlineMatch = true;
  hasOpponentConnected = true;
  isPlayerReady = true;
  isOpponentReady = true;
  deckSize = payload.deckSize || deckSize;
  isPerevodnoy = !!payload.isPerevodnoy;
  isPodkidnoy = !!payload.isPodkidnoy;
  if (payload.role) myNetworkRole = payload.role;
  if (payload.opponentName) setOpponentConnectedUI(payload.opponentName);
  hideActionButton();

  // Очистка стола/рук перед сетевой раздачей
  resetGameForNetworkDeal();

  // Козырь и колода с сервера
  trumpSuit = payload.trumpSuit || trumpSuit;
  const tc = payload.trumpCard || { rank: "6", suit: trumpSuit };
  applyTrumpCardUI(tc);
  // Остаток колоды — только визуальный счётчик. Не кладём ?-карты в gameDeck
  // (иначе startAutoDeal мог бы раздать их в руку игрока).
  const left = typeof payload.deckCount === "number" ? payload.deckCount : 0;
  gameDeck = []; // онлайн: реальные карты только с сервера
  // Фейковый счётчик для UI
  const deckCountEl = document.getElementById("deck-count");
  if (deckCountEl) {
    deckCountEl.textContent = String(left);
    deckCountEl.classList.add("visible");
  }
  // Сохраняем для логов
  window.__netDeckCount = left;

  // Кто ходит первым: server currentAttacker = "host"|"guest"
  const first = payload.currentAttacker || "host";
  if (myNetworkRole === first) {
    currentAttacker = "player";
  } else {
    currentAttacker = "bot"; // очередь соперника
  }
  console.log(`[net] start: role=${myNetworkRole}, first=${first}, localAttacker=${currentAttacker}`);

  // Раздача известных карт с сервера
  const hand = Array.isArray(payload.yourHand) ? payload.yourHand : [];
  const oppCount = payload.opponentHandCount || 6;
  dealNetworkHands(hand, oppCount);

  setTimeout(() => {
    initialDealDone = true;
    forceHideActionButton();
    animateButtonAndDeckDisappearance();
    updatePlayerHandLayout();
    updateBotHandLayout();
    makeHandDraggable();
    if (currentAttacker === "player") {
      console.log("[net] Ваш ход (атака)");
    } else {
      console.log("[net] Ход соперника — ждём game:move");
    }
    updateDeckEmptyUI(typeof payload.deckCount === "number" ? payload.deckCount : 0);
    updateTurnUI();
  }, 500);
}

function resetGameForNetworkDeal() {
  // Убрать карты со стола и из рук, сбросить флаги (без полного goToMainMenu)
  tableCards = [];
  tableCardsCount = 0;
  botIsTaking = false;
  isBitoPending = false;
  isDealing = false;
  initialDealDone = false;
  discardCards = [];
  if (botDefendTimer) { clearTimeout(botDefendTimer); botDefendTimer = null; }
  [playerHand, opponentHand].forEach((el) => {
    if (!el) return;
    el.querySelectorAll(".playing-card").forEach((c) => {
      try { if (c.draggableInstance) c.draggableInstance.kill(); } catch (_) {}
      c.remove();
    });
  });
  const disc = document.getElementById("discard-pile");
  if (disc) disc.innerHTML = "";
  document.querySelectorAll(".table > .playing-card").forEach((c) => c.remove());
}

function applyTrumpCardUI(trumpCardData) {
  const suit = trumpCardData.suit;
  const rank = trumpCardData.rank;
  trumpSuit = suit;
  const color = SUIT_COLOR[suit] || "black";
  const trumpFront = document.getElementById("trump-front");
  if (!trumpFront) return;
  const rankElements = trumpFront.querySelectorAll(".trump-rank");
  const suitElements = trumpFront.querySelectorAll(".trump-suit");
  const symbol = SUIT_SYMBOL[suit];
  trumpFront.className = `face front ${color}`;
  rankElements.forEach((el) => { el.textContent = rank; });
  suitElements.forEach((el) => { el.textContent = symbol; });
  const trumpCard = document.getElementById("trump-card");
  if (trumpCard) {
    trumpCard.style.opacity = "1";
    trumpCard.style.display = "";
    const c3 = trumpCard.querySelector(".card-3d");
    if (c3) gsap.set(c3, { rotateY: 180 });
  }
}

/** Раздать руку игрока (лицом) и N закрытых рубашек сопернику.
 *  yourHand — только реальные карты с сервера; opponentHand — только рубашки. */
function dealNetworkHands(yourHand, opponentCount) {
  // Полностью очищаем обе руки перед сетевой раздачей
  if (playerHand) {
    playerHand.querySelectorAll(".playing-card").forEach((c) => {
      try { if (c.draggableInstance) c.draggableInstance.kill(); } catch (_) {}
      c.remove();
    });
  }
  if (opponentHand) {
    opponentHand.querySelectorAll(".playing-card").forEach((c) => {
      try { if (c.draggableInstance) c.draggableInstance.kill(); } catch (_) {}
      c.remove();
    });
  }

  const hand = Array.isArray(yourHand) ? yourHand : [];
  let dealt = 0;
  hand.forEach((cd) => {
    if (!cd || !cd.rank || !cd.suit || cd.rank === "?" || cd.rank === "") {
      console.warn("[net] пропуск невалидной карты руки:", cd);
      return;
    }
    const suit = cd.suit;
    const rank = String(cd.rank);
    const color =
      (typeof SUIT_COLOR !== "undefined" && SUIT_COLOR[suit]) ||
      (suit === "hearts" || suit === "diamonds" ? "red" : "black");
    const card = createPlayingCard({ rank, suit, color });
    card.dataset.hidden = "0";
    playerHand.appendChild(card);
    const inner = card.querySelector(".card-3d");
    if (inner) gsap.set(inner, { rotationY: 180 });
    gsap.set(card, { scale: 1.28, x: 0, y: 0, rotation: 0 });
    dealt++;
  });
  cardsInHand = dealt;
  console.log(`[net] раздано игроку ${dealt} карт лицом вверх`);

  const n = Math.max(0, Number(opponentCount) || 0);
  for (let i = 0; i < n; i++) {
    // Строго закрытая рубашка — ранг не показываем
    const card = createPlayingCard({ rank: "?", suit: "spades", color: "black" });
    card.dataset.hidden = "1";
    card.dataset.rank = "?";
    card.dataset.suit = "spades";
    opponentHand.appendChild(card);
    const inner = card.querySelector(".card-3d");
    // rotationY: 0 = видна рубашка (back)
    if (inner) gsap.set(inner, { rotationY: 0 });
    gsap.set(card, { scale: 0.5, x: 0, y: 0, rotation: 0 });
  }
  botCardsInHand = n;
  console.log(`[net] рубашек сопернику: ${n}`);
}

function emitNetMove(move) {
  if (!isOnlineMatch || !socket) {
    console.warn("[net] emit skipped", { isOnlineMatch, hasSocket: !!socket });
    return;
  }
  if (!socket.connected) {
    console.warn("[net] socket not connected, move lost", move);
    return;
  }
  const payload = {
    ...move,
    tableId: myTableId,
    role: myNetworkRole,
    ts: Date.now(),
  };
  console.log("[net] emit move", payload);
  socket.emit("game:move", payload);
}

function updateTurnUI() {
  // Скрыть текстовые плашки хода (старый UI)
  const el = document.getElementById("turn-status");
  if (el) {
    el.style.display = "none";
    el.textContent = "";
  }
  document.querySelectorAll("#turn-status").forEach((n) => {
    n.style.display = "none";
  });

  const myAvatar = document.querySelector(".player-profile-btn");
  const oppAvatar = document.querySelector(".opponent-avatar");

  if (!isOnlineMatch || !initialDealDone) {
    if (myAvatar) myAvatar.classList.remove("turn-glow-green", "turn-glow-red");
    if (oppAvatar) oppAvatar.classList.remove("turn-glow-green", "turn-glow-red");
    return;
  }

  // Мой ход: зелёное свечение у моей аватарки, красное у соперника
  if (currentAttacker === "player") {
    if (myAvatar) {
      myAvatar.classList.add("turn-glow-green");
      myAvatar.classList.remove("turn-glow-red");
    }
    if (oppAvatar) {
      oppAvatar.classList.add("turn-glow-red");
      oppAvatar.classList.remove("turn-glow-green");
    }
  } else {
    if (myAvatar) {
      myAvatar.classList.add("turn-glow-red");
      myAvatar.classList.remove("turn-glow-green");
    }
    if (oppAvatar) {
      oppAvatar.classList.add("turn-glow-green");
      oppAvatar.classList.remove("turn-glow-red");
    }
  }
}

/** Колода пуста → спрятать колоду, показать индикатор масти козыря */
function updateDeckEmptyUI(deckCount) {
  const left = typeof deckCount === "number" ? deckCount : (window.__netDeckCount ?? 0);
  const deckEl = document.querySelector(".deck");
  const stockEl = document.querySelector(".stock");
  const countEl = document.getElementById("deck-count");
  const trumpCard = document.getElementById("trump-card");

  if (left <= 0) {
    if (deckEl) deckEl.style.display = "none";
    if (countEl) {
      countEl.textContent = "0";
      countEl.classList.remove("visible");
      countEl.style.opacity = "0";
    }
    // Козырная карта-подложка тоже убирается, остаётся индикатор масти
    if (trumpCard) {
      trumpCard.style.opacity = "0";
      trumpCard.style.display = "none";
    }
    showTrumpIndicator();
  } else {
    if (deckEl) deckEl.style.display = "";
    if (countEl) {
      countEl.textContent = String(left);
      countEl.classList.add("visible");
      countEl.style.opacity = "1";
    }
  }
}


function canLocalAttack() {
  if (!isOnlineMatch) return true;
  return currentAttacker === "player";
}

/** Можно ли локально защищаться / переводить */
function canLocalDefend() {
  if (!isOnlineMatch) return true;
  return currentAttacker === "bot";
}

/**
 * Применить ход соперника.
 */
function applyRemoteMove(move, fromRole) {
  if (!isOnlineMatch || !move || !move.type) {
    console.warn("[net] applyRemoteMove skip", move);
    return;
  }
  console.log("[net] apply remote", move, "from", fromRole);

  if (move.type === "attack" || move.type === "throw") {
    remotePlayAttack(move);
  } else if (move.type === "defend") {
    remotePlayDefend(move);
  } else if (move.type === "transfer") {
    remotePlayTransfer(move);
  } else if (move.type === "take") {
    botIsTaking = false;
    hideActionButton();
    botTakeCards();
    updateTurnUI();
  } else if (move.type === "force_take") {
    botIsTaking = false;
    hideActionButton();
    playerTakeCards();
    updateTurnUI();
  } else if (move.type === "bito") {
    isBitoPending = false;
    hideActionButton();
    const weWereAttacking = currentAttacker === "player";
    if (weWereAttacking) {
      sendTableToDiscard(false);
    } else {
      sendTableToDiscard(false);
      currentAttacker = "player";
    }
    updateTurnUI();
  }
}

function ensureOpponentCard(rank, suit) {
  let card = takeHiddenOpponentCard();
  if (card) {
    revealCardElement(card, rank, suit);
    return card;
  }
  // Нет рубашки — создаём карту с нуля (защита от рассинхрона раздачи)
  console.warn("[net] no hidden card, creating from move", rank, suit);
  const color = (typeof SUIT_COLOR !== "undefined" && SUIT_COLOR[suit]) || "black";
  card = createPlayingCard({ rank, suit, color });
  opponentHand.appendChild(card);
  gsap.set(card, { scale: 0.5, x: 0, y: 0, rotation: 0 });
  const inner = card.querySelector(".card-3d");
  if (inner) gsap.set(inner, { rotationY: 180 });
  return card;
}

function takeHiddenOpponentCard() {
  const cards = Array.from(opponentHand.querySelectorAll(".playing-card"));
  const hidden = cards.filter((c) => c.dataset.hidden === "1" || c.dataset.rank === "?");
  if (hidden.length) return hidden[hidden.length - 1];
  return cards.length ? cards[cards.length - 1] : null;
}

function revealCardElement(card, rank, suit) {
  if (!card) return;
  card.dataset.rank = rank;
  card.dataset.suit = suit;
  card.dataset.hidden = "0";
  const color = (typeof SUIT_COLOR !== "undefined" && SUIT_COLOR[suit]) || "black";
  const symbol = (typeof SUIT_SYMBOL !== "undefined" && SUIT_SYMBOL[suit]) || "";
  const front = card.querySelector(".face.front");
  if (front) {
    front.className = `face front ${color}`;
    front.innerHTML = `
      <span class="corner tl"><b>${rank}</b><i>${symbol}</i></span>
      <span class="pip">${symbol}</span>
      <span class="corner br"><b>${rank}</b><i>${symbol}</i></span>`;
  }
  const inner = card.querySelector(".card-3d");
  if (inner) gsap.to(inner, { rotateY: 180, duration: 0.25 });
}

function placeCardOnTableFromOpponent(card, isAttack, targetEl) {
  const tableElement = document.querySelector(".table");
  if (!tableElement || !card) return;

  const cardRect = card.getBoundingClientRect();
  const tableRect = tableElement.getBoundingClientRect();

  tableElement.appendChild(card);
  card.style.pointerEvents = "none";
  card.style.left = "50%";
  card.style.marginLeft = "calc(var(--card-w) / -2)";
  card.style.top = "0";

  const startX = cardRect.left + cardRect.width / 2 - (tableRect.left + tableRect.width / 2);
  const startY = cardRect.top + cardRect.height / 2 - (tableRect.top + tableRect.height / 2);

  gsap.killTweensOf(card);
  gsap.set(card, {
    x: startX,
    y: startY,
    rotation: 0,
    scale: 0.5,
    zIndex: isAttack ? 20 : 21,
  });

  if (isAttack) {
    tableCards.push({ element: card, isAttack: true, defendedBy: null });
  } else {
    tableCards.push({ element: card, isAttack: false, attackCardElement: targetEl || null });
  }
  tableCardsCount++;
  botCardsInHand = opponentHand.querySelectorAll(".playing-card").length;
  updateBotHandLayout();
  requestAnimationFrame(() => repositionTableCards());
}

function remotePlayAttack(move) {
  const card = ensureOpponentCard(move.rank, move.suit);
  placeCardOnTableFromOpponent(card, true, null);

  currentAttacker = "bot";
  botIsTaking = false;
  isBitoPending = false;
  updateTurnUI();
  setTimeout(() => {
    if (!isTableFullyDefended()) {
      showActionButton("Взять");
      botIsTaking = true;
    }
  }, 350);
}

function remotePlayDefend(move) {
  const card = ensureOpponentCard(move.rank, move.suit);

  let target = null;
  if (move.targetRank && move.targetSuit) {
    const atk = tableCards.find(
      (c) =>
        c.isAttack &&
        !tableCards.some((d) => !d.isAttack && d.attackCardElement === c.element) &&
        c.element.dataset.rank === String(move.targetRank) &&
        c.element.dataset.suit === String(move.targetSuit)
    );
    if (atk) target = atk.element;
  }
  if (!target) {
    const undefended = tableCards.filter(
      (c) => c.isAttack && !tableCards.some((d) => !d.isAttack && d.attackCardElement === c.element)
    );
    if (undefended.length) target = undefended[0].element;
  }

  placeCardOnTableFromOpponent(card, false, target);

  if (isTableFullyDefended()) {
    isBitoPending = true;
    botIsTaking = false;
    setTimeout(() => showActionButton("Бито"), 300);
  } else {
    // Соперник ещё не всё покрыл — мы можем подкинуть
    botIsTaking = false;
  }
  updateTurnUI();
}

function remotePlayTransfer(move) {
  const card = ensureOpponentCard(move.rank, move.suit);
  placeCardOnTableFromOpponent(card, true, null);

  currentAttacker = "bot";
  botIsTaking = false;
  isBitoPending = false;
  updateTurnUI();
  setTimeout(() => {
    showActionButton("Взять");
    botIsTaking = true;
  }, 350);
}




/**
 * Сервер закончил раунд (take/bito): руки, колода, ход.
 */
function applyNetworkRoundEnded(payload) {
  if (!payload || !isOnlineMatch) return;

  botIsTaking = false;
  isBitoPending = false;
  forceHideActionButton();

  document.querySelectorAll(".table > .playing-card").forEach((c) => {
    if (c.id !== "trump-card") c.remove();
  });
  tableCards = [];
  tableCardsCount = 0;

  const first = payload.currentAttacker || "host";
  const role = payload.role || myNetworkRole;
  currentAttacker = role === first ? "player" : "bot";

  const left = typeof payload.deckCount === "number" ? payload.deckCount : 0;
  window.__netDeckCount = left;
  gameDeck = [];
  updateDeckEmptyUI(left);

  syncPlayerHandFromServer(Array.isArray(payload.yourHand) ? payload.yourHand : []);
  syncOpponentHandCount(payload.opponentHandCount || 0);

  setTimeout(() => {
    updatePlayerHandLayout();
    updateBotHandLayout();
    makeHandDraggable();
    updateTurnUI();
    // Победа / поражение
    if (checkGameOver()) return;
    // Сервер мог прислать winner
    if (payload.winner) {
      const iWon = payload.winner === myNetworkRole;
      showGameOver(iWon);
      return;
    }
    console.log("[net] round_ended applied, attacker=", currentAttacker, "hand=", cardsInHand);
  }, 400);
}


function cardKey(rank, suit) {
  return String(rank) + "|" + String(suit);
}

function syncPlayerHandFromServer(yourHand) {
  const existing = Array.from(playerHand.querySelectorAll(".playing-card"));
  const needed = yourHand.map((c) => ({ rank: String(c.rank), suit: c.suit }));
  const neededKeys = needed.map((c) => cardKey(c.rank, c.suit));

  existing.forEach((el) => {
    const k = cardKey(el.dataset.rank, el.dataset.suit);
    const idx = neededKeys.indexOf(k);
    if (idx === -1) {
      try { if (el.draggableInstance) el.draggableInstance.kill(); } catch (_) {}
      el.remove();
    } else {
      neededKeys[idx] = null;
    }
  });

  const stillNeed = needed.filter((c, i) => neededKeys[i] !== null);
  stillNeed.forEach((cd, i) => {
    const color =
      (typeof SUIT_COLOR !== "undefined" && SUIT_COLOR[cd.suit]) ||
      (cd.suit === "hearts" || cd.suit === "diamonds" ? "red" : "black");
    const card = createPlayingCard({ rank: cd.rank, suit: cd.suit, color });
    card.dataset.hidden = "0";
    playerHand.appendChild(card);
    const inner = card.querySelector(".card-3d");
    if (inner) gsap.set(inner, { rotationY: 180 });

    const deckEl = document.getElementById("deck");
    if (deckEl) {
      const dr = deckEl.getBoundingClientRect();
      const pr = playerHand.getBoundingClientRect();
      const sx = dr.left + dr.width / 2 - (pr.left + pr.width / 2);
      const sy = dr.top + dr.height / 2 - (pr.top + pr.height / 2);
      gsap.set(card, { x: sx, y: sy, scale: 0.5, rotation: 0, opacity: 1 });
      gsap.to(card, {
        x: 0, y: 0, scale: 1.28,
        duration: 0.45, delay: i * 0.08, ease: "power2.out",
      });
    } else {
      gsap.set(card, { scale: 1.28, x: 0, y: 0, rotation: 0 });
    }
  });
  cardsInHand = playerHand.querySelectorAll(".playing-card").length;
}

function syncOpponentHandCount(count) {
  const n = Math.max(0, Number(count) || 0);
  let cards = Array.from(opponentHand.querySelectorAll(".playing-card"));
  while (cards.length > n) {
    const c = cards.pop();
    if (c) c.remove();
  }
  while (cards.length < n) {
    const card = createPlayingCard({ rank: "?", suit: "spades", color: "black" });
    card.dataset.hidden = "1";
    card.dataset.rank = "?";
    opponentHand.appendChild(card);
    const inner = card.querySelector(".card-3d");
    if (inner) gsap.set(inner, { rotationY: 0 });
    gsap.set(card, { scale: 0.5, x: 0, y: 0, rotation: 0 });
    cards.push(card);
  }
  botCardsInHand = n;
}

// Сохранённые (активные) значения — меняются только по «Сохранить» / «Начать»
let isPodkidnoy = true;
let isPerevodnoy = false;

// Временный выбор в модалке (до сохранения)
let pendingDeckSize = 36;
let pendingPodkidnoy = true;
let pendingPerevodnoy = false;

const opt36 = document.getElementById("opt-36");
const opt24 = document.getElementById("opt-24");
const optPodkidnoy = document.getElementById("opt-podkidnoy");
const optPerevodnoy = document.getElementById("opt-perevodnoy");

function syncSettingsUI() {
  if (opt36) opt36.checked = pendingDeckSize === 36;
  if (opt24) opt24.checked = pendingDeckSize === 24;
  if (optPodkidnoy) optPodkidnoy.checked = pendingPodkidnoy;
  if (optPerevodnoy) optPerevodnoy.checked = pendingPerevodnoy;
}

function updateSaveBtnLabel() {
  if (!settingsSaveBtn) return;
  settingsSaveBtn.textContent = isMenuTrainingOpen ? "Начать" : "Сохранить";
}

function openSettings(fromTraining = false) {
  if (!settingsModal) return;
  isMenuTrainingOpen = !!fromTraining;
  pendingDeckSize = deckSize;
  pendingPodkidnoy = isPodkidnoy;
  pendingPerevodnoy = isPerevodnoy;
  syncSettingsUI();
  updateSaveBtnLabel();
  settingsModal.style.display = "flex";
  gsap.fromTo(settingsModal, { opacity: 0 }, { opacity: 1, duration: 0.3 });
}

function closeSettings() {
  if (!settingsModal) return;
  isMenuTrainingOpen = false;
  updateSaveBtnLabel();
  gsap.to(settingsModal, {
    opacity: 0,
    duration: 0.25,
    onComplete() {
      settingsModal.style.display = "none";
    }
  });
}

function setOpponentWaitingUI() {
  const nameEl = document.querySelector(".opponent-name");
  const avatarEl = document.querySelector(".opponent-avatar");
  if (nameEl) nameEl.textContent = "Ожидание игрока...";
  if (avatarEl) {
    avatarEl.classList.add("is-waiting");
    avatarEl.innerHTML = `
      <div class="opponent-waiting-spinner" aria-hidden="true">
        <svg viewBox="0 0 48 48" width="36" height="36">
          <circle cx="24" cy="24" r="18" fill="none" stroke="rgba(224,184,74,0.25)" stroke-width="3"/>
          <path d="M24 6 a18 18 0 0 1 18 18" fill="none" stroke="#e0b84a" stroke-width="3" stroke-linecap="round">
            <animateTransform attributeName="transform" type="rotate" from="0 24 24" to="360 24 24" dur="1s" repeatCount="indefinite"/>
          </path>
        </svg>
      </div>`;
  }
}

function setOpponentConnectedUI(displayName = "Игрок_777") {
  const nameEl = document.querySelector(".opponent-name");
  const avatarEl = document.querySelector(".opponent-avatar");
  if (nameEl) nameEl.textContent = displayName;
  if (avatarEl) {
    avatarEl.classList.remove("is-waiting");
    // Плейсхолдер аватара сетевого игрока (не робот Алины)
    avatarEl.innerHTML = `
      <svg viewBox="0 0 64 64" width="100%" height="100%" aria-hidden="true">
        <defs>
          <linearGradient id="netAvGrad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="#3a2a1a"/>
            <stop offset="100%" stop-color="#1a1208"/>
          </linearGradient>
        </defs>
        <circle cx="32" cy="32" r="30" fill="url(#netAvGrad)" stroke="rgba(224,184,74,0.6)" stroke-width="2"/>
        <circle cx="32" cy="26" r="10" fill="#c9a84c"/>
        <ellipse cx="32" cy="48" rx="16" ry="12" fill="#c9a84c"/>
      </svg>`;
  }
}

function setOpponentBotUI() {
  const nameEl = document.querySelector(".opponent-name");
  const avatarEl = document.querySelector(".opponent-avatar");
  if (nameEl) nameEl.textContent = "БОТ АЛИНА";
  if (avatarEl) {
    avatarEl.classList.remove("is-waiting");
    avatarEl.innerHTML = `
      <svg viewBox="0 0 64 64" width="100%" height="100%" aria-hidden="true">
        <defs>
          <linearGradient id="botGrad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="#2a2a2a"/>
            <stop offset="100%" stop-color="#111"/>
          </linearGradient>
        </defs>
        <circle cx="32" cy="32" r="30" fill="url(#botGrad)" stroke="rgba(224,184,74,0.6)" stroke-width="2"/>
        <rect x="18" y="18" width="28" height="24" rx="8" fill="#e8e8e8"/>
        <circle cx="24" cy="28" r="4" fill="#1a1a1a"/>
        <circle cx="40" cy="28" r="4" fill="#1a1a1a"/>
        <circle cx="24" cy="28" r="1.5" fill="#e0b84a"/>
        <circle cx="40" cy="28" r="1.5" fill="#e0b84a"/>
        <rect x="26" y="35" width="12" height="3" rx="1.5" fill="#888"/>
        <line x1="32" y1="18" x2="32" y2="12" stroke="#e0b84a" stroke-width="2"/>
        <circle cx="32" cy="10" r="3" fill="#e0b84a"/>
      </svg>`;
  }
}

function startTrainingMatch() {
  document.querySelector(".table")?.classList.add("game-active");

  // Одиночный матч против бота
  isOnlineMatch = false;
  setOpponentBotUI();
  playButton.disabled = true;
  gsap.to(startMenu, {
    opacity: 0,
    duration: 0.4,
    ease: "power2.inOut",
    onComplete() {
      startMenu.style.display = "none";
      gsap.to(opponentProfile, { opacity: 1, duration: 0.3 });
    }
  });
}

/**
 * Хост создал стол — ждём гостя (спиннер, без кнопки).
 * Гость НЕ должен вызывать эту функцию без имени — для гостя enterOnlineTableAsGuest.
 */
function startOnlineWaiting(opts = {}) {
  isOnlineMatch = true;
  isPlayerReady = false;
  isOpponentReady = false;
  hasOpponentConnected = false;
  pendingOpponentName = opts.opponentName || pendingOpponentName || null;

  setOpponentWaitingUI();
  playButton.disabled = true;
  if (dealButton) {
    gsap.killTweensOf(dealButton);
    dealButton.style.display = "none";
    dealButton.style.opacity = "0";
    dealButton.disabled = true;
  }
  if (onlineJoinTimer) { clearTimeout(onlineJoinTimer); onlineJoinTimer = null; }
  if (onlineReadyTimer) { clearTimeout(onlineReadyTimer); onlineReadyTimer = null; }

  hideMenusForGame();
  if (opponentProfile) {
    gsap.set(opponentProfile, { opacity: 1 });
    opponentProfile.style.opacity = "1";
  }
  console.log("Онлайн-стол (хост): ожидание гостя");
}

/** Синхронно закрыть меню/лобби и показать игровой стол */
function hideMenusForGame() {
  if (lobbyModal) {
    gsap.killTweensOf(lobbyModal);
    lobbyModal.style.display = "none";
    lobbyModal.style.opacity = "0";
    lobbyModal.setAttribute("aria-hidden", "true");
  }
  if (createGameModal) {
    gsap.killTweensOf(createGameModal);
    createGameModal.style.display = "none";
    createGameModal.style.opacity = "0";
    createGameModal.setAttribute("aria-hidden", "true");
  }
  if (startMenu) {
    gsap.killTweensOf(startMenu);
    startMenu.style.display = "none";
    startMenu.style.opacity = "0";
  }
}

/**
 * Гость вошёл за стол — СРАЗУ имя хоста + кнопка ГОТОВ.
 * Без анимационных гонок (главный фикс телефона).
 */
function enterOnlineTableAsGuest(hostName) {
  const name = hostName || pendingOpponentName || "Хост";
  isOnlineMatch = true;
  myNetworkRole = myNetworkRole || "guest";
  isPlayerReady = false;
  isOpponentReady = false;
  hasOpponentConnected = true;
  pendingOpponentName = null;

  hideMenusForGame();
  playButton.disabled = true;

  if (opponentProfile) {
    gsap.set(opponentProfile, { opacity: 1 });
    opponentProfile.style.opacity = "1";
  }
  setOpponentConnectedUI(name);
  forceShowActionButton("Готов");
  console.log("[net] ГОСТЬ за столом, хост=", name, "→ кнопка ГОТОВ");
}

/** Не стартуем локально в онлайне — ждём game:start с сервера */
function checkPlayersReady() {
  if (!isOnlineMatch || !hasOpponentConnected) return;
  if (isPlayerReady && isOpponentReady) {
    console.log("Оба игрока готовы — ждём game:start с сервера...");
    forceShowActionButton("Ожидание...");
    if (dealButton) dealButton.disabled = true;
  }
}

/** Отложить показ соперника, пока не скрыто меню */
function queueOpponentJoined(displayName) {
  const name = displayName || "Игрок";
  // Всегда сохраняем — даже если isOnlineMatch ещё false (гонка ack vs event)
  pendingOpponentName = name;
  if (!isOnlineMatch) {
    console.log("[net] queue opponent (ещё не online):", name);
    return;
  }
  const menuVisible = startMenu && startMenu.style.display !== "none";
  if (menuVisible) {
    console.log("[net] queue opponent (меню ещё открыто):", name);
    return;
  }
  onOpponentJoined(name);
}

/**
 * Соперник за столом: аватар + кнопка «Готов».
 * Из консоли: onOpponentJoined("Имя")
 */
function onOpponentJoined(displayName = "Игрок") {
  isOnlineMatch = true;
  hasOpponentConnected = true;
  if (!isPlayerReady) {
    isOpponentReady = false;
  }
  // Убедиться что меню не перекрывает стол (гость)
  hideMenusForGame();
  if (opponentProfile) {
    opponentProfile.style.opacity = "1";
    gsap.set(opponentProfile, { opacity: 1 });
  }
  setOpponentConnectedUI(displayName);
  console.log(`Соперник за столом: ${displayName}. Кнопка ГОТОВ.`);
  if (!isPlayerReady) {
    forceShowActionButton("Готов");
  } else {
    forceShowActionButton("Ожидание...");
    if (dealButton) dealButton.disabled = true;
    checkPlayersReady();
  }
}

/** Сеть: соперник нажал «Готов» */
function onOpponentReady() {
  if (!isOnlineMatch || !hasOpponentConnected) return;
  isOpponentReady = true;
  console.log("Соперник нажал ГОТОВ!");
  checkPlayersReady();
}

/** Показать кнопку действий без гонки с hideActionButton */
function forceShowActionButton(text) {
  if (!dealButton) return;
  gsap.killTweensOf(dealButton);
  const bar = document.querySelector(".game-action-bar");
  if (bar && dealButton.parentElement !== bar) bar.appendChild(dealButton);
  dealButton.style.position = "";
  dealButton.style.top = "";
  dealButton.style.left = "";
  dealButton.style.transform = "";
  dealButton.style.zIndex = "";
  dealButton.style.display = "flex";
  dealButton.style.opacity = "1";
  dealButton.disabled = false;
  gsap.set(dealButton, { clearProps: "transform,x,y,scale", opacity: 1, scale: 1 });
  setActionBtnText(text);
  gsap.fromTo(dealButton,
    { opacity: 0.6, scale: 0.94 },
    { opacity: 1, scale: 1, duration: 0.25, ease: "power2.out" }
  );
}

// Алиас для совместимости (ручной тест из консоли)
function simulateOpponentJoin(name) {
  onOpponentJoined(name || "Игрок_777");
}

// Доступ из DevTools: onOpponentJoined("Вася"); onOpponentReady();
window.onOpponentJoined = onOpponentJoined;
window.onOpponentReady = onOpponentReady;
window.simulateOpponentJoin = simulateOpponentJoin;

// «Тренировка» → открыть настройки с кнопкой «Начать»
playButton.addEventListener("click", () => {
  isOnlineMatch = false;
  openSettings(true);
});

// Радио-группы на чекбоксах (без перезапуска игры)
opt36?.addEventListener("change", () => {
  if (opt36.checked) {
    pendingDeckSize = 36;
    if (opt24) opt24.checked = false;
  } else {
    opt36.checked = true;
  }
  syncSettingsUI();
});
opt24?.addEventListener("change", () => {
  if (opt24.checked) {
    pendingDeckSize = 24;
    if (opt36) opt36.checked = false;
  } else {
    opt24.checked = true;
  }
  syncSettingsUI();
});
optPodkidnoy?.addEventListener("change", () => {
  if (optPodkidnoy.checked) {
    pendingPodkidnoy = true;
    pendingPerevodnoy = false;
    if (optPerevodnoy) optPerevodnoy.checked = false;
  } else {
    optPodkidnoy.checked = true;
  }
  syncSettingsUI();
});
optPerevodnoy?.addEventListener("change", () => {
  if (optPerevodnoy.checked) {
    pendingPerevodnoy = true;
    pendingPodkidnoy = false;
    if (optPodkidnoy) optPodkidnoy.checked = false;
  } else {
    optPerevodnoy.checked = true;
  }
  syncSettingsUI();
});

// Сохранить / Начать
settingsSaveBtn?.addEventListener("click", () => {
  const wasTraining = isMenuTrainingOpen;
  deckSize = pendingDeckSize;
  isPodkidnoy = pendingPodkidnoy;
  isPerevodnoy = pendingPerevodnoy;
  console.log(`Настройки: ${deckSize} карт, ${isPerevodnoy ? "Переводной" : "Подкидной"}`);
  initGame();
  closeSettings();
  if (wasTraining) {
    startTrainingMatch();
  }
});

settingsBtn?.addEventListener("click", () => openSettings(false));
settingsClose?.addEventListener("click", closeSettings);

document.getElementById("header-settings-btn")?.addEventListener("click", () => openSettings(false));
document.getElementById("tab-settings-btn")?.addEventListener("click", () => openSettings(false));

syncSettingsUI();
updateSaveBtnLabel();

// ===== Онлайн-лобби / создание стола =====
const lobbyModal = document.getElementById("lobby-modal");
const createGameModal = document.getElementById("create-game-modal");
const lobbyFilterLabel = document.getElementById("lobby-filter-label");
const playMatchBtn = document.getElementById("play-match-btn");
const lobbyBackBtn = document.getElementById("lobby-back-btn");
const lobbyCreateBtn = document.getElementById("lobby-create-btn");
const confirmCreateBtn = document.getElementById("confirm-create-btn");
const createGameCancel = document.getElementById("create-game-cancel");

const createOpt36 = document.getElementById("create-opt-36");
const createOpt24 = document.getElementById("create-opt-24");
const createOptPodkidnoy = document.getElementById("create-opt-podkidnoy");
const createOptPerevodnoy = document.getElementById("create-opt-perevodnoy");

let pendingCreateDeckSize = 36;
let pendingCreatePodkidnoy = true;
let pendingCreatePerevodnoy = false;

function getOnlineFilterText() {
  const mode = isPerevodnoy ? "Переводной" : "Подкидной";
  return `Фильтр: ${deckSize} карт, ${mode}`;
}

function renderLobbyTables() {
  const list = document.getElementById("lobby-tables-list");
  if (!list) return;
  list.innerHTML = "";

  const filtered = networkTables.filter((t) => {
    if (t.deckSize !== deckSize) return false;
    if (t.isPerevodnoy !== isPerevodnoy) return false;
    return true;
  });

  if (filtered.length === 0) {
    const hint = document.createElement("p");
    hint.id = "lobby-empty-hint";
    hint.className = "lobby-empty-hint";
    hint.textContent = socket && socket.connected
      ? "Пока нет открытых столов. Создайте свой!"
      : "Нет связи с сервером. Запустите npm start на ПК.";
    list.appendChild(hint);
    return;
  }

  filtered.forEach((t) => {
    const mode = t.isPerevodnoy ? "Переводной" : "Подкидной";
    const article = document.createElement("article");
    article.className = "lobby-table-card";
    article.setAttribute("role", "listitem");
    article.dataset.tableId = String(t.id);
    article.innerHTML = `
      <div class="lobby-table-info">
        <span class="lobby-table-id">Стол #${t.id}</span>
        <span class="lobby-table-meta">Игрок: <b>${t.hostName}</b></span>
        <span class="lobby-table-meta">Козырь: ? · ${t.deckSize} · ${mode}</span>
      </div>
      <button type="button" class="lobby-join-btn" data-join="${t.id}">Войти</button>
    `;
    list.appendChild(article);
  });
}

function openLobby() {
  if (!lobbyModal) return;
  if (lobbyFilterLabel) lobbyFilterLabel.textContent = getOnlineFilterText();
  if (socket && socket.connected) {
    socket.emit("lobby:list", { deckSize, isPerevodnoy });
  }
  renderLobbyTables();
  console.log(`Открыто лобби с фильтром: ${deckSize} карт, ${isPerevodnoy ? "Переводной" : "Подкидной"}`);
  lobbyModal.style.display = "flex";
  lobbyModal.setAttribute("aria-hidden", "false");
  gsap.fromTo(lobbyModal, { opacity: 0 }, { opacity: 1, duration: 0.3 });
}

function closeLobby() {
  if (!lobbyModal) return;
  gsap.to(lobbyModal, {
    opacity: 0,
    duration: 0.22,
    onComplete() {
      lobbyModal.style.display = "none";
      lobbyModal.setAttribute("aria-hidden", "true");
    }
  });
}

function syncCreateGameUI() {
  if (createOpt36) createOpt36.checked = pendingCreateDeckSize === 36;
  if (createOpt24) createOpt24.checked = pendingCreateDeckSize === 24;
  if (createOptPodkidnoy) createOptPodkidnoy.checked = pendingCreatePodkidnoy;
  if (createOptPerevodnoy) createOptPerevodnoy.checked = pendingCreatePerevodnoy;
}

function openCreateGameModal() {
  if (!createGameModal) return;
  pendingCreateDeckSize = deckSize;
  pendingCreatePodkidnoy = isPodkidnoy;
  pendingCreatePerevodnoy = isPerevodnoy;
  syncCreateGameUI();
  createGameModal.style.display = "flex";
  createGameModal.setAttribute("aria-hidden", "false");
  gsap.fromTo(createGameModal, { opacity: 0 }, { opacity: 1, duration: 0.25 });
}

function closeCreateGameModal() {
  if (!createGameModal) return;
  gsap.to(createGameModal, {
    opacity: 0,
    duration: 0.2,
    onComplete() {
      createGameModal.style.display = "none";
      createGameModal.setAttribute("aria-hidden", "true");
    }
  });
}

// «ИГРАТЬ» → лобби с текущим онлайн-фильтром
playMatchBtn?.addEventListener("click", () => {
  openLobby();
});

lobbyBackBtn?.addEventListener("click", closeLobby);

lobbyCreateBtn?.addEventListener("click", () => {
  openCreateGameModal();
});

createGameCancel?.addEventListener("click", closeCreateGameModal);

createOpt36?.addEventListener("change", () => {
  if (createOpt36.checked) {
    pendingCreateDeckSize = 36;
    if (createOpt24) createOpt24.checked = false;
  } else {
    createOpt36.checked = true;
  }
  syncCreateGameUI();
});
createOpt24?.addEventListener("change", () => {
  if (createOpt24.checked) {
    pendingCreateDeckSize = 24;
    if (createOpt36) createOpt36.checked = false;
  } else {
    createOpt24.checked = true;
  }
  syncCreateGameUI();
});
createOptPodkidnoy?.addEventListener("change", () => {
  if (createOptPodkidnoy.checked) {
    pendingCreatePodkidnoy = true;
    pendingCreatePerevodnoy = false;
    if (createOptPerevodnoy) createOptPerevodnoy.checked = false;
  } else {
    createOptPodkidnoy.checked = true;
  }
  syncCreateGameUI();
});
createOptPerevodnoy?.addEventListener("change", () => {
  if (createOptPerevodnoy.checked) {
    pendingCreatePerevodnoy = true;
    pendingCreatePodkidnoy = false;
    if (createOptPodkidnoy) createOptPodkidnoy.checked = false;
  } else {
    createOptPerevodnoy.checked = true;
  }
  syncCreateGameUI();
});

// Подтвердить создание стола → сервер + экран ожидания
confirmCreateBtn?.addEventListener("click", () => {
  deckSize = pendingCreateDeckSize;
  isPodkidnoy = pendingCreatePodkidnoy;
  isPerevodnoy = pendingCreatePerevodnoy;
  isOnlineMatch = true;

  if (!socket || !socket.connected) {
    alert("Нет связи с сервером. Запустите на ПК: npm start");
    return;
  }

  socket.emit(
    "lobby:create",
    {
      deckSize,
      isPerevodnoy,
      isPodkidnoy,
      hostName: PLAYER_DISPLAY_NAME,
    },
    (res) => {
      if (!res?.ok) {
        alert(res?.error || "Не удалось создать стол");
        return;
      }
      myTableId = res.tableId;
      myNetworkRole = "host";
      console.log(`[net] стол #${res.tableId} создан, ждём гостя`);
      closeCreateGameModal();
      closeLobby();
      startOnlineWaiting();
    }
  );
});

// «Войти» за стол из лобби (сеть)
document.getElementById("lobby-tables-list")?.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-join]");
  if (!btn) return;
  const id = btn.getAttribute("data-join");
  if (!socket || !socket.connected) {
    alert("Нет связи с сервером");
    return;
  }
  socket.emit(
    "lobby:join",
    { tableId: id, playerName: PLAYER_DISPLAY_NAME },
    (res) => {
      if (!res?.ok) {
        alert(res?.error || "Не удалось войти");
        return;
      }
      myTableId = res.tableId;
      myNetworkRole = res.role || "guest";
      isOnlineMatch = true;
      const hostName = res.opponentName || pendingOpponentName || "Хост";
      console.log(`[net] вошли за стол #${id} как guest, хост=`, hostName, res);
      // Сразу ГОТОВ (table:joined может прийти раньше/позже — enter идемпотентен)
      enterOnlineTableAsGuest(hostName);
    }
  );
});

// Все масти и их символы
const SUIT_SYMBOL = {
  hearts: "♥",
  diamonds: "♦",
  clubs: "♣",
  spades: "♠",
};

// Соответствие мастей и цветов для CSS классов
const SUIT_COLOR = {
  hearts: "red",
  diamonds: "red",
  clubs: "black",
  spades: "black",
};

const rankValues = {
  "6": 6, "7": 7, "8": 8, "9": 9, "10": 10,
  "J": 11, "Q": 12, "K": 13, "A": 14
};

let botIsTaking = false; // Флаг: согласился ли бот взять карты со стола / или игрок берёт
let isBitoPending = false; // Флаг: ждём нажатия «Бито»
let botDefendTimer = null; // debounce ответа бота — защита от гонки при быстром подкиде
// Инкрементируется в resetGame — отменяет «поздние» onComplete от hide/startAutoDeal прошлой партии
let gameSessionId = 0;
let tableCards = [];
let tableCardsCount = 0; // Считаем, сколько карт уже выброшено на стол
let gameDeck = []; // Перемешанная колода
let cardsInHand = 0; // Карты локального игрока (нижний веер)
// Рука соперника сверху: в тренировке — бот Алина, в онлайне — второй игрок (симметрия сети)
let botCardsInHand = 0;
let isDealing = false;
let trumpSuit = "";
let currentReceiver = "player"; // Кто сейчас получает карту ("player" или "bot"/opponent)
let initialDealDone = false; // Флаг: первая раздача уже прошла
let currentAttacker = "player"; // Кто атакует: "player" или "bot" (opponent)
let discardCards = []; // Карты в отбое

function updateDeckCount() {
  const el = document.getElementById("deck-count");
  if (el) {
    el.textContent = gameDeck.length;
    if (gameDeck.length === 0) {
      el.classList.remove("visible");
      el.style.display = "none";
    } else {
      el.style.display = "block";
      // Видимость управляется классом .visible (появляется после сдвига колоды)
    }
  }
  // Когда колода пустеет — показываем индикатор козыря (только если ещё не показан)
  if (gameDeck.length === 0) {
    showTrumpIndicator();
  }
}

function showTrumpIndicator() {
  const trumpCard = document.getElementById("trump-card");
  const indicator = document.getElementById("trump-indicator");
  const symbolEl = document.getElementById("trump-indicator-symbol");
  if (!indicator || !symbolEl) return;

  // Уже показан — не перезапускаем анимацию (иначе мигает после каждого хода)
  if (indicator.style.display === "flex" && indicator.style.opacity !== "0") {
    return;
  }

  // Прячем саму козырную карту
  if (trumpCard) {
    gsap.to(trumpCard, { opacity: 0, duration: 0.3, onComplete() {
      trumpCard.style.display = "none";
    }});
  }
  // Прячем стопку колоды
  const deckEl = document.querySelector(".deck");
  if (deckEl) {
    gsap.to(deckEl, { opacity: 0, duration: 0.3 });
  }
  // Прячем счётчик
  const countEl = document.getElementById("deck-count");
  if (countEl) {
    countEl.classList.remove("visible");
    countEl.style.display = "none";
  }

  symbolEl.textContent = SUIT_SYMBOL[trumpSuit] || "♠";
  indicator.className = "trump-indicator " + (SUIT_COLOR[trumpSuit] || "black");
  indicator.style.display = "flex";
  gsap.fromTo(indicator, { opacity: 0, scale: 0.6 }, { opacity: 1, scale: 1, duration: 0.35, ease: "back.out(1.4)" });
}

function checkGameOver() {
  // Считаем реальные карты в руках (не на столе)
  const playerCards = playerHand.querySelectorAll(".playing-card").length;
  const botCards = opponentHand.querySelectorAll(".playing-card").length;

  if (playerCards === 0 && tableCards.length === 0) {
    showGameOver(true);  // игрок выиграл
    return true;
  }
  if (botCards === 0 && tableCards.length === 0) {
    showGameOver(false); // бот выиграл (игрок — дурак)
    return true;
  }
  return false;
}

function showGameOver(playerWon) {
  const overlay = document.getElementById("game-over");
  const title = document.getElementById("game-over-title");
  const subtitle = document.getElementById("game-over-subtitle");
  if (!overlay) return;

  forceHideActionButton();
  // сброс подсветки хода
  document.querySelectorAll(".turn-glow-green, .turn-glow-red").forEach((n) => {
    n.classList.remove("turn-glow-green", "turn-glow-red");
  });

  if (playerWon) {
    title.textContent = "Победа!";
    subtitle.textContent = isOnlineMatch ? "Соперник — дурак" : "Бот Алина — дурак";
  } else {
    title.textContent = "Поражение";
    subtitle.textContent = "Вы — дурак";
  }

  overlay.style.display = "flex";
  gsap.fromTo(overlay, { opacity: 0 }, { opacity: 1, duration: 0.4 });
}

function resetGame() {
  // Новая сессия — все отложенные onComplete старой партии игнорируются
  gameSessionId++;

  // Полный сброс состояния
  tableCards = [];
  tableCardsCount = 0;
  discardCards = [];
  cardsInHand = 0;
  botCardsInHand = 0;
  isDealing = false;
  initialDealDone = false;
  currentAttacker = "player";
  currentReceiver = "player";
  botIsTaking = false;
  isBitoPending = false;
  clearTimeout(botDefendTimer);
  botDefendTimer = null;

  // Убиваем Draggable на картах до очистки DOM (на случай, если узлы ещё живы)
  try {
    const allDrag = typeof Draggable !== "undefined" && Draggable.get ? Draggable.get(".playing-card") : null;
    if (allDrag) {
      (Array.isArray(allDrag) ? allDrag : [allDrag]).forEach((d) => {
        try { d.kill(); } catch (_) {}
      });
    }
  } catch (_) {}

  // Очищаем руки и отбой
  playerHand.innerHTML = "";
  opponentHand.innerHTML = "";
  const discardPile = document.getElementById("discard-pile");
  if (discardPile) discardPile.innerHTML = "";

  // КРИТИЧНО: удаляем все карты, лежащие на столе (атака/защита)
  const tableEl = document.querySelector(".table");
  if (tableEl) {
    tableEl.querySelectorAll(":scope > .playing-card").forEach((card) => {
      gsap.killTweensOf(card);
      if (card.draggableInstance) {
        try { card.draggableInstance.kill(); } catch (_) {}
        card.draggableInstance = null;
      }
      card.remove();
    });
  }

  // Возвращаем колоду (.stock) в центр без сдвига
  const stockEl = document.querySelector(".stock") || document.getElementById("deck");
  if (stockEl) {
    gsap.killTweensOf(stockEl);
    gsap.set(stockEl, { clearProps: "transform,x,y,xPercent,yPercent,scale,left,top,right,bottom" });
    stockEl.style.left = "";
    stockEl.style.top = "";
    stockEl.style.transform = "";
  }
  // На всякий случай сбрасываем и table-center (раньше сдвигали его)
  const tableCenter = document.querySelector(".table-center");
  if (tableCenter) {
    gsap.killTweensOf(tableCenter);
    gsap.set(tableCenter, { clearProps: "transform,x,y,xPercent,yPercent,scale" });
  }

  // Козырная карта — строго скрыта до конца раздачи
  const trumpCard = document.getElementById("trump-card");
  if (trumpCard) {
    gsap.killTweensOf(trumpCard);
    // Не clearProps: all — иначе сбивается CSS .trump (rotate 90deg)
    gsap.set(trumpCard, { clearProps: "opacity,visibility,x,y,scale,rotation,transform" });
    trumpCard.style.opacity = "0";
    trumpCard.style.display = "";
    trumpCard.style.visibility = "visible";
    // Убеждаемся, что козырь снова внутри колоды
    if (stockEl && trumpCard.parentElement !== stockEl) {
      stockEl.insertBefore(trumpCard, stockEl.firstChild);
    }
    const trump3d = trumpCard.querySelector(".card-3d");
    if (trump3d) {
      gsap.killTweensOf(trump3d);
      gsap.set(trump3d, { clearProps: "transform,rotationY" });
    }
  }

  // Стопка колоды снова видна
  const deckLayers = document.querySelector(".deck");
  if (deckLayers) {
    gsap.killTweensOf(deckLayers);
    gsap.set(deckLayers, { clearProps: "opacity,transform,scale" });
    deckLayers.style.opacity = "1";
    deckLayers.style.display = "";
  }

  // Индикатор козыря скрыт
  const indicator = document.getElementById("trump-indicator");
  if (indicator) {
    gsap.killTweensOf(indicator);
    indicator.style.display = "none";
    indicator.style.opacity = "0";
  }

  // Прячем оверлей окончания
  const overlay = document.getElementById("game-over");
  if (overlay) {
    overlay.style.display = "none";
    overlay.style.opacity = "0";
  }

  // Новая колода (данные), козырь визуально скрыт
  initGame();
  updateDeckCount();

  const deckCountEl = document.getElementById("deck-count");
  if (deckCountEl) {
    deckCountEl.classList.remove("visible");
    deckCountEl.style.display = "block";
    deckCountEl.style.opacity = "0";
  }

  // Кнопка «Раздать» в нижней панели — жёсткий сброс после killTweens
  gsap.killTweensOf(dealButton);
  dealButton.disabled = false;
  dealButton.style.cssText = "";
  dealButton.style.display = "flex";
  dealButton.style.opacity = "1";
  dealButton.style.visibility = "visible";
  setActionBtnText("Раздать");

  const actionBar = document.querySelector(".game-action-bar");
  if (actionBar && dealButton.parentElement !== actionBar) {
    actionBar.appendChild(dealButton);
  }
  gsap.set(dealButton, {
    clearProps: "transform,x,y,scale,opacity,position,top,left",
    opacity: 1,
    scale: 1
  });

  // Повторный force на следующий кадр — перекрывает late onComplete hideActionButton
  const sessionAtReset = gameSessionId;
  requestAnimationFrame(() => {
    if (sessionAtReset !== gameSessionId) return;
    gsap.killTweensOf(dealButton);
    dealButton.style.display = "flex";
    dealButton.style.opacity = "1";
    dealButton.disabled = false;
  });

  playerHand.classList.remove("hand-dealt");
}


// Создаем колоду, мешаем и выбираем козырь при запуске игры
initGame();

function initGame() {
  gameDeck = createDeck(deckSize);
  shuffle(gameDeck);
  setRandomTrump();
  updateDeckCount();
}

function createDeck(size = 36) {
  // 36 карт: 6–A,  24 карты: 9–A
  const ranks = size === 24
    ? ["9", "10", "J", "Q", "K", "A"]
    : ["6", "7", "8", "9", "10", "J", "Q", "K", "A"];
  const suits = ["hearts", "diamonds", "clubs", "spades"];
  const deckArray = [];

  for (const suit of suits) {
    for (const rank of ranks) {
      deckArray.push({
        rank: rank,
        suit: suit,
        color: SUIT_COLOR[suit]
      });
    }
  }
  return deckArray;
}

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
}

function setRandomTrump() {
  const trumpCardData = gameDeck[0]; 
  trumpSuit = trumpCardData.suit;

  const trumpFront = document.getElementById("trump-front");
  const rankElements = trumpFront.querySelectorAll(".trump-rank");
  const suitElements = trumpFront.querySelectorAll(".trump-suit");
  const symbol = SUIT_SYMBOL[trumpSuit];

  trumpFront.className = `face front ${trumpCardData.color}`;
  rankElements.forEach(el => el.textContent = trumpCardData.rank);
  suitElements.forEach(el => el.textContent = symbol);
}

function setActionBtnText(text) {
  const label = dealButton.querySelector(".action-btn-text");
  if (label) {
    label.textContent = text;
  } else {
    dealButton.textContent = text;
  }
}

function hideActionButton() {
  const session = gameSessionId;
  gsap.killTweensOf(dealButton);
  dealButton.disabled = true;
  gsap.to(dealButton, {
    opacity: 0,
    duration: 0.2,
    onComplete() {
      if (session !== gameSessionId) return;
      // Защищаем «Готов»/«Ожидание» ТОЛЬКО до начала раздачи
      const label = dealButton.querySelector(".action-btn-text");
      const t = (label ? label.textContent : "").trim().toLowerCase();
      if (
        isOnlineMatch &&
        hasOpponentConnected &&
        !initialDealDone &&
        (t === "готов" || t.includes("ожидание"))
      ) {
        dealButton.style.display = "flex";
        dealButton.style.opacity = "1";
        dealButton.disabled = t.includes("ожидание");
        return;
      }
      dealButton.style.display = "none";
      dealButton.style.opacity = "0";
      setActionBtnText("Раздать");
    }
  });
}

/** Жёстко спрятать кнопку (после старта партии / в конце раунда) */
function forceHideActionButton() {
  if (!dealButton) return;
  gsap.killTweensOf(dealButton);
  dealButton.disabled = true;
  dealButton.style.display = "none";
  dealButton.style.opacity = "0";
  setActionBtnText("Раздать");
}

function showActionButton(text) {
  const map = {
    "Раздать карты": "Раздать",
    "Отдать боту": "Отдать",
    "Взять": "Взять",
    "Бито": "Бито",
    "Готов": "Готов",
    "Ожидание...": "Ожидание...",
  };
  const short = map[text] || text;
  forceShowActionButton(short);
}

dealButton.addEventListener("click", () => {
  // Сетевой режим: кнопка «Готов» до старта партии
  if (isOnlineMatch && hasOpponentConnected && !initialDealDone) {
    const label = dealButton.querySelector(".action-btn-text");
    const currentText = (label ? label.textContent : dealButton.textContent || "").trim().toLowerCase();
    if (currentText === "готов" || currentText === "готово") {
      isPlayerReady = true;
      dealButton.disabled = true;
      setActionBtnText("Ожидание...");
      console.log("Локальный игрок нажал ГОТОВ");
      if (socket && socket.connected) {
        socket.emit("table:ready");
      }
      checkPlayersReady();
      return;
    }
    // Уже ждут второго — повторный клик игнорируем
    if (currentText.includes("ожидание") || currentText.includes("готовы")) {
      return;
    }
  }

  if (botIsTaking && currentAttacker === "player") {
    // Тренировка: отдать боту. В онлайне соперник сам жмёт «Взять»
    botIsTaking = false;
    hideActionButton();
    if (isOnlineMatch) {
      // На всякий случай: форс-отдать если кнопка всё же показана
      emitNetMove({ type: "force_take" });
    }
    botTakeCards();
  } else if (botIsTaking && currentAttacker === "bot") {
    // Мы (защитник) берём карты
    botIsTaking = false;
    hideActionButton();
    if (isOnlineMatch) emitNetMove({ type: "take" });
    playerTakeCards();
  } else if (isBitoPending) {
    isBitoPending = false;
    hideActionButton();
    if (isOnlineMatch) {
      emitNetMove({ type: "bito" });
      // После бито ход переходит сопернику
      sendTableToDiscard(true); // sets attacker to bot, online botAttack no-op
    } else {
      sendTableToDiscard(true);
    }
  } else {
    // В онлайне до готовности раздачу вручную не запускаем
    if (isOnlineMatch && !initialDealDone) return;
    startAutoDeal();
  }
});

function startAutoDeal() {
  // СЧИТАЕМ РЕАЛЬНОЕ КОЛИЧЕСТВО КАРТ В РУКАХ ПЕРЕД РАЗДАЧЕЙ
  cardsInHand = playerHand.querySelectorAll(".playing-card").length;
  botCardsInHand = opponentHand.querySelectorAll(".playing-card").length;

  // Онлайн: локальная колода — заглушка (rank "?"), добор с неё ломает руку.
  // Пока добор только локальный для тренировки; в сети карты приходят с сервера.
  if (isOnlineMatch) {
    console.log("[net] startAutoDeal пропущен (онлайн) — без добора ?-карт");
    isDealing = false;
    updatePlayerHandLayout();
    updateBotHandLayout();
    setTimeout(makeHandDraggable, 250);
    updateTurnUI();
    return;
  }

  if (isDealing || (cardsInHand >= MAX_CARDS_IN_HAND && botCardsInHand >= MAX_CARDS_IN_HAND)) return;

  setActionBtnText("Раздать");
  isDealing = true;
  dealButton.disabled = true;
  currentReceiver = "player";
  // Полностью скрываем кнопку на время раздачи
  const session = gameSessionId;
  gsap.killTweensOf(dealButton);
  gsap.to(dealButton, {
    opacity: 0,
    duration: 0.15,
    onComplete() {
      if (session !== gameSessionId) return;
      dealButton.style.display = "none";
    }
  });

  dealNextCardAutomated();
}

function dealNextCardAutomated() {
  // Условие полного окончания раздачи: если у обоих игроков уже по 6 (или более) карт
  if (cardsInHand >= MAX_CARDS_IN_HAND && botCardsInHand >= MAX_CARDS_IN_HAND) {
    isDealing = false;
    if (!initialDealDone) {
      initialDealDone = true;
      animateButtonAndDeckDisappearance();
    } else {
      // Повторный добор — только обновляем раскладку и делаем карты перетаскиваемыми
      updatePlayerHandLayout();
      updateBotHandLayout();
      setTimeout(makeHandDraggable, 300);
    }
    return;
  }

  // Если колода полностью опустела во время раздачи — останавливаем процесс
  if (gameDeck.length === 0) {
    isDealing = false;
    updateDeckCount(); // покажет индикатор козыря
    if (!initialDealDone) {
      initialDealDone = true;
      animateButtonAndDeckDisappearance();
    } else {
      updatePlayerHandLayout();
      updateBotHandLayout();
      setTimeout(makeHandDraggable, 300);
    }
    return;
  }

  // УМНОЕ ПЕРЕКЛЮЧЕНИЕ ОЧЕРЕДИ:
  // Если сейчас очередь игрока, но у него уже есть 6 карт — передаем очередь боту
  if (currentReceiver === "player" && cardsInHand >= MAX_CARDS_IN_HAND) {
    currentReceiver = "bot";
  } 
  // Если сейчас очередь бота, но у него уже есть 6 карт — передаем очередь игроку
  else if (currentReceiver === "bot" && botCardsInHand >= MAX_CARDS_IN_HAND) {
    currentReceiver = "player";
  }

  // Забираем карту из колоды
  const cardData = gameDeck.pop();
  updateDeckCount();
  if (!cardData) {
    isDealing = false;
    if (!initialDealDone) {
      initialDealDone = true;
      animateButtonAndDeckDisappearance();
    } else {
      updatePlayerHandLayout();
      updateBotHandLayout();
      setTimeout(makeHandDraggable, 300);
    }
    return;
  }

  const card = createPlayingCard(cardData);
  
  let targetHand, pose, currentCount;
  let targetScale = 1.0; 
  
  if (currentReceiver === "player") {
    targetHand = playerHand;
    pose = getFanPose(cardsInHand);
    targetScale = 1.28;
    currentCount = cardsInHand;
  } else {
    targetHand = opponentHand;
    pose = { x: 0, y: 0, rotation: 0 }; 
    targetScale = 0.50; 
    currentCount = botCardsInHand;
  }

  targetHand.appendChild(card);

  const start = getOffsetFromDeck(card);
  const inner = card.querySelector(".card-3d");

  gsap.set(card, {
    x: start.x,
    y: start.y,
    rotation: -12,
    scale: 0.92,
    zIndex: 20 + currentCount,
  });
  gsap.set(inner, { rotationY: 0 });

  const timeline = gsap.timeline({
    onComplete() {
      if (currentReceiver === "player") {
        cardsInHand += 1;
        currentReceiver = "bot";
        updatePlayerHandLayout(); // Твоя рабочая строчка
      } else {
        botCardsInHand += 1;
        currentReceiver = "player";
        
        // ВАЖНО: Как только новая карта из колоды долетела к боту, центрируем его веер!
        updateBotHandLayout();
      }

      setTimeout(dealNextCardAutomated, 30);
    },
  });

  timeline.to(card, {
    x: pose.x,
    y: pose.y,
    rotation: pose.rotation,
    scale: targetScale, 
    duration: 0.23, 
    ease: "power2.out",
  }, 0);

  if (currentReceiver === "player") {
    timeline.to(inner, {
      rotationY: 180,
      duration: 0.28,
      ease: "power1.inOut",
    }, 0.08);
  }
}

// Функция красивого исчезновения интерфейса раздачи и раскрытия карт бота веером
function animateButtonAndDeckDisappearance() {
  // 1. Кнопка действий полностью скрыта до следующего действия
  playerHand.classList.add("hand-dealt");
  dealButton.disabled = true;
  gsap.to(dealButton, {
    opacity: 0,
    duration: 0.25,
    ease: "power2.inOut",
    onComplete() {
      dealButton.style.display = "none";
    }
  });

  // 2. Сдвигаем .stock к левому краю — ~половина карты за краем экрана
  const stockEl = document.querySelector(".stock") || deck;
  const tableEl = document.querySelector(".table");
  const tableW = tableEl ? tableEl.clientWidth : 360;
  const stockW = stockEl ? (stockEl.offsetWidth || 64) : 64;

  // stock сейчас по центру стола → уводим влево так, чтобы
  // левый край карты был примерно на -0.35 * ширины карты (чуть больше трети скрыто)
  const stockRect = stockEl.getBoundingClientRect();
  const tableRect = tableEl.getBoundingClientRect();
  const currentLeft = stockRect.left - tableRect.left;
  const desiredLeft = -stockW * 0.60; // часть колоды уходит за левый край
  const shiftX = desiredLeft - currentLeft;

  gsap.to(stockEl, {
    x: shiftX,
    scale: 0.75,
    duration: 0.55,
    ease: "power2.inOut"
  });

  // 3. ЭФФЕКТ КОЗЫРЯ: Плавно проявляем козырную карту
  const trumpCard = document.getElementById("trump-card");
  gsap.to(trumpCard, {
    opacity: 1,        
    duration: 0.4,
    delay: 0.1,        
    ease: "power2.out"
  });

  // Показываем счётчик колоды после сдвига
  const deckCountEl = document.getElementById("deck-count");
  if (deckCountEl) {
    deckCountEl.style.display = "block";
    deckCountEl.textContent = gameDeck.length;
    setTimeout(() => {
      deckCountEl.classList.add("visible");
      deckCountEl.style.opacity = "1";
    }, 350);
  }

  // 4. ФИНАЛЬНЫЙ ВЕЕР БОТА: Уменьшаем карты соперника и раскладываем их под аватаркой
  const botCards = opponentHand.querySelectorAll(".playing-card");
  
  botCards.forEach((card, index) => {
    const finalPose = getBotFanPose(index); 
    
    gsap.to(card, {
      x: finalPose.x,
      y: finalPose.y,
      rotation: finalPose.rotation,
      scale: 0.50,            // чуть уменьшаем, чтобы гармонично прятались под аватаркой
      duration: 0.45,         
      delay: 0.15,            
      ease: "back.out(1.2)"   // Приятный пружинящий эффект раскрытия
    });
  });
  setTimeout(makeHandDraggable, 500);
}

function createPlayingCard({ rank, suit, color }) {
  const symbol = (SUIT_SYMBOL && SUIT_SYMBOL[suit]) || "";
  const col = color || (SUIT_COLOR && SUIT_COLOR[suit]) || "black";
  const card = document.createElement("div");
  card.className = "playing-card";
  card.dataset.rank = rank;
  card.dataset.suit = suit;
  card.innerHTML = `
    <div class="card-3d">
      <div class="face back"></div>
      <div class="face front ${col}">
        <span class="corner tl"><b>${rank}</b><i>${symbol}</i></span>
        <span class="pip">${symbol}</span>
        <span class="corner br"><b>${rank}</b><i>${symbol}</i></span>
      </div>
    </div>
  `;
  return card;
}

function getOffsetFromDeck(card) {
  const deckElement = deck.querySelector(".deck") || deck;
  const deckRect = deckElement.getBoundingClientRect();
  const cardRect = card.getBoundingClientRect();

  return {
    x: deckRect.left + deckRect.width / 2 - (cardRect.left + cardRect.width / 2),
    y: deckRect.top + deckRect.height / 2 - (cardRect.top + cardRect.height / 2),
  };
}

function getFanPose(index) {
  const mid = (MAX_CARDS_IN_HAND - 1) / 2;
  const t = index - mid;
  return {
    x: t * 38, // по горизонтали веер у игрока
    y: Math.abs(t) * 5, // прогиб поо вертикали
    rotation: t * 7, // угол поворота карты
  };
}

function getBotFanPose(index) {
  const mid = (MAX_CARDS_IN_HAND - 1) / 2;
  const t = index - mid;
  
  return {
    x: t * 18,           // Оптимальный шаг, чтобы было видно количество карт
    y: -Math.abs(t) * 4, // Меняем знак на минус: крайние карты уходят ВВЕРХ, создавая форму (∪)
    rotation: -t * 10    // Инвертируем угол поворота для обратного веера
  };
}

function makeHandDraggable() {
  const cards = playerHand.querySelectorAll(".playing-card");
  const dropZone = document.getElementById("drop-zone");

  cards.forEach((card) => {
    card.originalX = gsap.getProperty(card, "x");
    card.originalY = gsap.getProperty(card, "y");
    card.originalRotation = gsap.getProperty(card, "rotation");

    // Уже есть живой инстанс — только обновляем original*, не плодим дубли
    if (card.draggableInstance) {
      return;
    }

    // На всякий случай убиваем «осиротевший» Draggable на этом узле
    try {
      const existing = Draggable.get(card);
      if (existing) {
        (Array.isArray(existing) ? existing : [existing]).forEach((d) => d.kill());
      }
    } catch (_) {}

    Draggable.create(card, {
      type: "x,y",
      edgeResistance: 0.4,
      
      onDragStart() {
        // Сигнализируем вееру, что эту карту пока не нужно учитывать в расчете
        card.dataset.dragging = "true";
        updatePlayerHandLayout();

        // Поднимаем карту на самый верхний слой во время таскания
        gsap.set(card, { zIndex: 1000, rotation: 0 });
      },

      onDrag() {
        if (this.hitTest(dropZone, "50%")) { 
          dropZone.classList.add("active");
        } else {
          dropZone.classList.remove("active");
        }
      },

      onDragEnd() {
        dropZone.classList.remove("active");
        delete card.dataset.dragging; // Карта больше не тащится

        let isValidPlay = false;
        let isDefense = false;
        let targetAttackCard = null;
        let isTransfer = false;
        let droppedInPlayArea = false;

        const attackCountOnTable = tableCards.filter(c => c.isAttack).length;

        // ===== Бот забирает карты: любой сброс на стол = только подкид (атака) =====
        if (botIsTaking && currentAttacker === "player") {
          if (this.hitTest(dropZone, "50%")) {
            droppedInPlayArea = true;
            const currentRank = card.dataset.rank;
            const isRankOnTable = tableCards.some(tc => tc.element.dataset.rank === currentRank);
            // Лимит: не больше MAX_ATTACKS_ON_TABLE атакующих карт
            if (isRankOnTable && attackCountOnTable < MAX_ATTACKS_ON_TABLE) {
              isValidPlay = true;
              isDefense = false;
              isTransfer = false;
              targetAttackCard = null;
            } else if (attackCountOnTable >= MAX_ATTACKS_ON_TABLE) {
              console.log("Лимит атак на столе (6). Подкид запрещён.");
            }
          }
        } else if (currentAttacker === "player") {
          // Атака (только в свой ход)
          if (isOnlineMatch && !canLocalAttack()) {
            // не наш ход
          } else if (this.hitTest(dropZone, "50%")) {
            droppedInPlayArea = true;
            const currentRank = card.dataset.rank;
            const isTableEmpty = tableCards.length === 0;
            const isRankOnTable = tableCards.some(tableCard => {
              return tableCard.element.dataset.rank === currentRank;
            });
            const underLimit = attackCountOnTable < MAX_ATTACKS_ON_TABLE;
            isValidPlay = underLimit && (isTableEmpty || isRankOnTable);
            if (!underLimit) {
              console.log("Лимит атак на столе (6). Ход запрещён.");
            }
          }
        } else if (currentAttacker === "bot") {
          // Защита / перевод (ход соперника — мы отвечаем)
          if (isOnlineMatch && !canLocalDefend() && !(botIsTaking && currentAttacker === "player")) {
            // safety
          }
          const undefendedAttacks = tableCards.filter(c => c.isAttack && !tableCards.some(d => !d.isAttack && d.attackCardElement === c.element));
          const anyDefenseOnTable = tableCards.some(c => !c.isAttack);
          // Широкая зона стола для перевода / общего сброса
          const inDropZone = this.hitTest(dropZone, "25%");
          const isTransferCandidate = isPerevodnoy && !anyDefenseOnTable &&
            undefendedAttacks.some(a => a.element.dataset.rank === card.dataset.rank);

          // 1) Отбой только при СИЛЬНОМ пересечении с картой атаки (прицел)
          //    Для кандидатов на перевод порог выше (55%), чтобы «рядом» = перевод
          const beatThreshold = isTransferCandidate ? "55%" : "35%";
          for (const attack of undefendedAttacks) {
            if (this.hitTest(attack.element, beatThreshold) && canBeat(attack.element, card)) {
              isValidPlay = true;
              isDefense = true;
              targetAttackCard = attack.element;
              droppedInPlayArea = true;
              break;
            }
          }

          // 2) Перевод: та же сила, бросок рядом / в сторону (не прицельно на карту)
          if (!isValidPlay && inDropZone && isTransferCandidate) {
            droppedInPlayArea = true;
            const attacksAfterTransfer = undefendedAttacks.length + 1;
            const botHandCount = opponentHand.querySelectorAll(".playing-card").length;
            if (attacksAfterTransfer <= botHandCount && attacksAfterTransfer <= MAX_ATTACKS_ON_TABLE) {
              isValidPlay = true;
              isTransfer = true;
            } else {
              console.log(`Перевод запрещён: лимит карт у бота или на столе`);
            }
          }

          // 3) Авто-отбой в центр — только если карта НЕ кандидат на перевод
          if (!isValidPlay && inDropZone && !isTransferCandidate) {
            droppedInPlayArea = true;
            for (const attack of undefendedAttacks) {
              if (canBeat(attack.element, card)) {
                isValidPlay = true;
                isDefense = true;
                targetAttackCard = attack.element;
                break;
              }
            }
          }
        }

        if (!droppedInPlayArea) {
          // Отпустили мимо стола — возвращаем в руку
          gsap.set(card, { zIndex: 999 });
          gsap.to(card, {
            x: card.originalX,
            y: card.originalY,
            rotation: card.originalRotation,
            duration: 0.35,
            ease: "back.out(1.2)",
            onComplete() {
              gsap.set(card, { zIndex: "" });
              updatePlayerHandLayout();
            }
          });
          return;
        }

        if (!isValidPlay) {
          console.log("Нельзя сыграть эту карту сейчас.");
          gsap.set(card, { zIndex: 999 });
          gsap.to(card, {
            x: card.originalX,
            y: card.originalY,
            rotation: card.originalRotation,
            duration: 0.35,
            ease: "back.out(1.2)",
            onComplete() {
              gsap.set(card, { zIndex: "" });
              updatePlayerHandLayout();
            }
          });
          return;
        }

        // Успешный сброс карты игрока на стол
        const tableElement = document.querySelector(".table");
        tableElement.appendChild(card);
        this.disable();
        card.style.pointerEvents = "none";

        gsap.set(card, { x: 0, y: 0, rotation: 0, zIndex: 10 });

        if (isTransfer) {
          tableCards.push({
            element: card,
            isAttack: true,
            defendedBy: null
          });
          tableCardsCount++;
          currentAttacker = "player";
          botIsTaking = false;
          isBitoPending = false;
          hideActionButton();
          repositionTableCards();
          updatePlayerHandLayout();
          console.log("Игрок перевёл ход!");
          emitNetMove({
            type: "transfer",
            rank: card.dataset.rank,
            suit: card.dataset.suit,
          });
          if (isOnlineMatch) {
            currentAttacker = "player";
            updateTurnUI();
          } else {
            clearTimeout(botDefendTimer);
            botDefendTimer = setTimeout(() => botDefend(), 450);
          }
        } else if (isDefense) {
          tableCards.push({
            element: card,
            isAttack: false,
            attackCardElement: targetAttackCard
          });
          tableCardsCount++;
          repositionTableCards();
          updatePlayerHandLayout();
          console.log("Игрок успешно отбился!");
          emitNetMove({
            type: "defend",
            rank: card.dataset.rank,
            suit: card.dataset.suit,
            targetRank: targetAttackCard ? targetAttackCard.dataset.rank : null,
            targetSuit: targetAttackCard ? targetAttackCard.dataset.suit : null,
          });

          if (isTableFullyDefended()) {
            botIsTaking = false;
            isBitoPending = true;
            hideActionButton();
            if (isOnlineMatch) {
              setTimeout(() => showActionButton("Бито"), 400);
              updateTurnUI();
            } else {
              isBitoPending = false;
              setTimeout(() => sendTableToDiscard(false), 500);
            }
          } else {
            botIsTaking = true;
            showActionButton("Взять");
          }
        } else {
          // Игрок атакует / подкидывает
          tableCards.push({
            element: card,
            isAttack: true,
            defendedBy: null
          });
          tableCardsCount++;
          repositionTableCards();
          updatePlayerHandLayout();
          emitNetMove({
            type: botIsTaking ? "throw" : "attack",
            rank: card.dataset.rank,
            suit: card.dataset.suit,
          });

          if (botIsTaking) {
            showActionButton(isOnlineMatch ? "Отдать" : "Отдать боту");
            console.log(`Подкид принят. На столе: ${tableCardsCount}`);
          } else if (isOnlineMatch) {
            console.log(`[net] Атака отправлена. На столе: ${tableCardsCount}`);
            hideActionButton();
            updateTurnUI();
          } else {
            clearTimeout(botDefendTimer);
            botDefendTimer = setTimeout(() => botDefend(), 500);
            console.log(`Карта успешно сыграна на стол! Всего на столе: ${tableCardsCount}`);
          }
        }
      } // onDragEnd
    }); // Draggable.create

    // Привязываем ссылку на плагин к карте для обновления позиций
    card.draggableInstance = Draggable.get(card);

  }); // cards.forEach
}

function updatePlayerHandLayout() {
  const remainingCards = Array.from(playerHand.querySelectorAll(".playing-card")).filter(card => {
    return card.style.pointerEvents !== "none" && !card.dataset.dragging;
  });

  const totalRemaining = remainingCards.length;
  if (totalRemaining === 0) return;

  const mid = (totalRemaining - 1) / 2;

  // Адаптивный шаг: сжимаем веер, если карт больше 6, чтобы не вылезал за края
  const stepX = totalRemaining <= 6 ? 38 : Math.max(18, 220 / totalRemaining);
  const stepRot = totalRemaining <= 6 ? 7 : Math.max(3.5, 42 / totalRemaining);
  const stepY = totalRemaining <= 6 ? 5 : Math.max(2, 28 / totalRemaining);

  remainingCards.forEach((card, index) => {
    const t = index - mid;
    const newX = t * stepX;
    const newY = Math.abs(t) * stepY;
    const newRotation = t * stepRot;

    card.originalX = newX;
    card.originalY = newY;
    card.originalRotation = newRotation;

    gsap.to(card, {
      x: newX,
      y: newY,
      rotation: newRotation,
      scale: 1.28,
      zIndex: index,
      duration: 0.3,
      ease: "power2.out",
      onComplete() {
        if (card.draggableInstance) {
          card.draggableInstance.vars.originalX = newX;
          card.draggableInstance.vars.originalY = newY;
          card.draggableInstance.vars.originalRotation = newRotation;
        }
      }
    });
  });
}

function repositionTableCards() {
  // Находим все карты атаки на столе
  const attackCards = tableCards.filter(c => c.isAttack);
  const totalAttacks = attackCards.length;
  if (totalAttacks === 0) return;

  // Сетка 2 ряда × 3 колонки (макс 6 пар)
  const cols = 3;
  const totalRows = Math.ceil(totalAttacks / cols);

  // Все размеры — доли от текущей ширины/высоты стола (резиновая вёрстка)
  const tableEl = document.querySelector(".table");
  const tableW = tableEl ? tableEl.clientWidth : 360;
  const tableH = tableEl ? tableEl.clientHeight : 640;

  // Горизонтальный шаг ≈ 22% ширины стола, вертикальный ≈ 16% высоты
  const colSpacing = tableW * 0.22;
  const rowSpacing = tableH * 0.20;

  // Центр игровой зоны по вертикали (~42% высоты стола)
  const centerY = tableH * 0.42;
  const blockHeight = (totalRows - 1) * rowSpacing;
  const startY = centerY - blockHeight / 2;

  // Смещение защиты — тоже относительное
  const defOffsetX = tableW * 0.03;
  const defOffsetY = tableH * 0.025;

  tableCards.forEach((cardObj) => {
    let offsetX, offsetY, cardRotation, calculatedZIndex;
    let attackIndex = 0;

    if (cardObj.isAttack) {
      attackIndex = attackCards.indexOf(cardObj);
    } else if (cardObj.attackCardElement) {
      attackIndex = attackCards.findIndex(c => c.element === cardObj.attackCardElement);
      if (attackIndex === -1) attackIndex = 0;
    }

    const row = Math.floor(attackIndex / cols);
    // Сколько карт реально в этом ряду (для корректного центрирования)
    const cardsInThisRow = (row === 0)
      ? Math.min(totalAttacks, cols)
      : totalAttacks - cols;
    // Индекс карты внутри своего ряда (0..cardsInThisRow-1)
    const colInRow = attackIndex % cols;
    // Центр ряда: средний индекс = (cardsInThisRow - 1) / 2
    const rowMid = (cardsInThisRow - 1) / 2;

    // Горизонталь: строго по центру ряда относительно середины стола (x=0)
    offsetX = (colInRow - rowMid) * colSpacing;
    offsetY = startY + row * rowSpacing;

    if (cardObj.isAttack) {
      cardRotation = Math.random() * 4 - 2;
      calculatedZIndex = 10 + attackIndex * 2;
    } else {
      // Защита чуть правее и ниже своей атаки (относительные смещения)
      offsetX += defOffsetX;
      offsetY += defOffsetY;
      cardRotation = Math.random() * 6 + 2;
      calculatedZIndex = 10 + attackIndex * 2 + 1;
    }

    gsap.to(cardObj.element, {
      x: offsetX,
      y: offsetY,
      rotation: cardRotation,
      zIndex: calculatedZIndex,
      scale: 0.90,
      duration: 0.3,
      ease: "power2.out"
    });
  });
}

function canBeat(attackCard, defendCard) {
  const aRank = attackCard.dataset.rank;
  const aSuit = attackCard.dataset.suit;
  const dRank = defendCard.dataset.rank;
  const dSuit = defendCard.dataset.suit;

  // Козырь бьёт любую не-козырную
  if (dSuit === trumpSuit && aSuit !== trumpSuit) return true;
  // Та же масть и старше
  if (dSuit === aSuit && rankValues[dRank] > rankValues[aRank]) return true;
  // Козырь бьёт младший козырь
  if (dSuit === trumpSuit && aSuit === trumpSuit && rankValues[dRank] > rankValues[aRank]) return true;
  return false;
}

function isTableFullyDefended() {
  const attacks = tableCards.filter(c => c.isAttack);
  if (attacks.length === 0) return false;
  return attacks.every(attack => {
    return tableCards.some(c => !c.isAttack && c.attackCardElement === attack.element);
  });
}

function botDefend() {
  // Сетевой матч: ИИ отключён — ждём пакет хода соперника
  if (isOnlineMatch) {
    console.log("Ожидание сетевого пакета хода от Игрок_777...");
    return;
  }

  // Бот уже согласился брать — только ждём «Отдать», не отбиваемся
  if (botIsTaking) {
    console.log("Бот забирает карты. Подкид принят без защиты.");
    showActionButton("Отдать боту");
    return;
  }

  // Пока идёт раздача — отложим ответ
  if (isDealing) {
    clearTimeout(botDefendTimer);
    botDefendTimer = setTimeout(() => botDefend(), 200);
    return;
  }

  const botCards = Array.from(opponentHand.querySelectorAll(".playing-card")).filter(c => {
    return !tableCards.some(tc => tc.element === c);
  });

  const undefendedAttacks = tableCards.filter(c =>
    c.isAttack && !tableCards.some(d => !d.isAttack && d.attackCardElement === c.element)
  );
  const anyDefenseOnTable = tableCards.some(c => !c.isAttack);

  if (undefendedAttacks.length === 0) {
    if (isTableFullyDefended()) {
      isBitoPending = true;
      setTimeout(() => showActionButton("Бито"), 300);
    }
    return;
  }

  // Переводной: бот может перевести, если ещё никто не крылся
  let transferCard = null;
  if (isPerevodnoy && !anyDefenseOnTable && undefendedAttacks.length > 0) {
    const attacksAfterTransfer = undefendedAttacks.length + 1;
    const playerHandCount = playerHand.querySelectorAll(".playing-card").length;
    if (attacksAfterTransfer <= playerHandCount) {
      const attackRanks = new Set(undefendedAttacks.map(a => a.element.dataset.rank));
      let bestVal = Infinity;
      botCards.forEach(botCard => {
        if (attackRanks.has(botCard.dataset.rank)) {
          const val = rankValues[botCard.dataset.rank] + (botCard.dataset.suit === trumpSuit ? 30 : 0);
          if (val < bestVal) {
            bestVal = val;
            transferCard = botCard;
          }
        }
      });
    } else {
      console.log(`Бот не переводит: у игрока ${playerHandCount} карт, а на столе станет ${attacksAfterTransfer}`);
    }
  }

  if (transferCard) {
    const cardRect = transferCard.getBoundingClientRect();
    const tableElement = document.querySelector(".table");
    const tableRect = tableElement.getBoundingClientRect();

    tableElement.appendChild(transferCard);
    transferCard.style.pointerEvents = "none";
    transferCard.style.left = "50%";
    transferCard.style.marginLeft = "calc(var(--card-w) / -2)";
    transferCard.style.top = "0";

    const startX = cardRect.left + cardRect.width / 2 - (tableRect.left + tableRect.width / 2);
    const startY = cardRect.top + cardRect.height / 2 - (tableRect.top + tableRect.height / 2);

    gsap.killTweensOf(transferCard);
    gsap.set(transferCard, {
      x: startX,
      y: startY,
      rotation: gsap.getProperty(transferCard, "rotation") || 0,
      scale: 0.50,
      zIndex: 21
    });

    tableCards.push({
      element: transferCard,
      isAttack: true,
      defendedBy: null
    });
    tableCardsCount++;

    const card3d = transferCard.querySelector(".card-3d");
    if (card3d) {
      gsap.to(card3d, { rotateY: 180, duration: 0.3 });
    }

    currentAttacker = "bot";
    botIsTaking = false;
    isBitoPending = false;

    updateBotHandLayout();
    requestAnimationFrame(() => {
      repositionTableCards();
    });
    console.log("Бот перевёл ход!");

    setTimeout(() => {
      showActionButton("Взять");
      botIsTaking = true;
    }, 500);
    return;
  }

  // All-or-nothing: если бот не может отбить ВСЕ неприкрытые атаки — сразу берёт, без частичного отбоя
  // (важно после перевода: не отбивать 2 из 4, а сразу «Отдать»)
  const availableForCheck = [...botCards];
  let canBeatAll = true;
  for (const attack of undefendedAttacks) {
    let bestIdx = -1;
    let bestVal = Infinity;
    availableForCheck.forEach((bc, i) => {
      if (canBeat(attack.element, bc)) {
        const val = rankValues[bc.dataset.rank] + (bc.dataset.suit === trumpSuit ? 20 : 0);
        if (val < bestVal) {
          bestVal = val;
          bestIdx = i;
        }
      }
    });
    if (bestIdx < 0) {
      canBeatAll = false;
      break;
    }
    availableForCheck.splice(bestIdx, 1);
  }

  if (!canBeatAll) {
    console.log("Боту нечем крыть все атаки — берёт карты, без частичного отбоя.");
    botIsTaking = true;
    showActionButton("Отдать боту");
    return;
  }

  // Бьём самую раннюю неприкрытую атаку
  const targetAttack = undefendedAttacks[0].element;
  let winningCard = null;
  let bestValue = Infinity;

  botCards.forEach(botCard => {
    if (canBeat(targetAttack, botCard)) {
      const val = rankValues[botCard.dataset.rank] + (botCard.dataset.suit === trumpSuit ? 20 : 0);
      if (val < bestValue) {
        bestValue = val;
        winningCard = botCard;
      }
    }
  });

  if (winningCard) {
    const cardRect = winningCard.getBoundingClientRect();
    const tableElement = document.querySelector(".table");
    const tableRect = tableElement.getBoundingClientRect();

    tableElement.appendChild(winningCard);
    winningCard.style.pointerEvents = "none";
    winningCard.style.left = "50%";
    winningCard.style.marginLeft = "calc(var(--card-w) / -2)";
    winningCard.style.top = "0";

    const startX = cardRect.left + cardRect.width / 2 - (tableRect.left + tableRect.width / 2);
    const startY = cardRect.top + cardRect.height / 2 - (tableRect.top + tableRect.height / 2);

    gsap.killTweensOf(winningCard);
    gsap.set(winningCard, {
      x: startX,
      y: startY,
      rotation: gsap.getProperty(winningCard, "rotation") || 0,
      scale: 0.50,
      zIndex: 21
    });

    winningCard.attackCardElement = targetAttack;

    tableCards.push({
      element: winningCard,
      isAttack: false,
      attackCardElement: targetAttack
    });

    tableCardsCount++;

    const card3d = winningCard.querySelector(".card-3d");
    if (card3d) {
      gsap.to(card3d, { rotateY: 180, duration: 0.3 });
    }

    updateBotHandLayout();
    requestAnimationFrame(() => {
      repositionTableCards();
    });
    console.log("Бот успешно отбился!");

    // Остались неприкрытые — продолжаем (мы уже знаем, что canBeatAll)
    const stillUndefended = tableCards.filter(c =>
      c.isAttack && !tableCards.some(d => !d.isAttack && d.attackCardElement === c.element)
    );
    if (stillUndefended.length > 0) {
      clearTimeout(botDefendTimer);
      botDefendTimer = setTimeout(() => botDefend(), 400);
    } else if (isTableFullyDefended()) {
      isBitoPending = true;
      setTimeout(() => showActionButton("Бито"), 400);
    }
  } else {
    // На всякий случай (не должно сработать после canBeatAll)
    console.log("Боту нечем крыться, он ждёт решения игрока.");
    botIsTaking = true;
    showActionButton("Отдать боту");
  }
}

function botTakeCards() {
  if (tableCards.length === 0) return;

  const cardsToTake = tableCards.map(c => c.element);

  // Очищаем массив стола и сбрасываем счетчик
  tableCards = [];
  tableCardsCount = 0;

  const handRect = opponentHand.getBoundingClientRect();

  // Переносим карты в руку бота с корректной стартовой точкой и анимацией в веер
  cardsToTake.forEach((card, index) => {
    // Запоминаем текущую позицию на столе
    const cardRect = card.getBoundingClientRect();

    gsap.killTweensOf(card);

    opponentHand.appendChild(card);
    card.style.pointerEvents = "none";
    // Стили как у карт в руке бота (CSS top: -68px + left 50%)
    card.style.left = "50%";
    card.style.marginLeft = "calc(var(--card-w) / -2)";
    card.style.top = ""; // сбрасываем table top:0, пусть работает CSS .opponent-hand .playing-card

    // Стартовая позиция относительно контейнера руки
    const startX = cardRect.left + cardRect.width / 2 - (handRect.left + handRect.width / 2);
    const startY = cardRect.top + cardRect.height / 2 - (handRect.top + handRect.height / 2);

    gsap.set(card, {
      x: startX,
      y: startY,
      rotation: gsap.getProperty(card, "rotation") || 0,
      scale: 0.72,
      zIndex: 50 + index
    });

    // Рубашкой вверх
    const inner = card.querySelector(".card-3d");
    if (inner) {
      gsap.to(inner, {
        rotationY: 0,
        duration: 0.35,
        delay: index * 0.04
      });
    }
  });

  // После небольшой паузы (чтобы стартовые точки зафиксировались) раскладываем весь веер
  requestAnimationFrame(() => {
    updateBotHandLayout();
  });

  // После анимации обновляем счётчики и запускаем добор из колоды
  setTimeout(() => {
    // Разрешаем pointerEvents снова (хотя для бота не критично)
    cardsToTake.forEach(c => { c.style.pointerEvents = "auto"; });

    botCardsInHand = opponentHand.querySelectorAll(".playing-card").length;
    cardsInHand = playerHand.querySelectorAll(".playing-card").length;
    console.log(`Бот закончил брать карты. Теперь карт в руке у бота: ${botCardsInHand}`);
    
    currentReceiver = "player"; 
    isDealing = false; 
    currentAttacker = "player";
    
    if (isOnlineMatch) {
      updateTurnUI();
      return; // game:round_ended
    }
    if (checkGameOver()) return;
    console.log("Запускаем автоматический добор карт из колоды...");
    startAutoDeal();
  }, cardsToTake.length * 50 + 550);
}

function playerTakeCards() {
  if (tableCards.length === 0) return;

  const cardsToTake = tableCards.map(c => c.element);

  tableCards = [];
  tableCardsCount = 0;

  cardsToTake.forEach((card, index) => {
    gsap.killTweensOf(card);
    // Сбрасываем трансформы стола, но не ломаем базовую геометрию карты
    gsap.set(card, { clearProps: "transform,x,y,rotation,scale,zIndex" });

    playerHand.appendChild(card);
    card.style.pointerEvents = "auto";
    // Как у обычных карт руки — CSS .player-hand .playing-card задаёт position/left/top
    card.style.left = "50%";
    card.style.marginLeft = "calc(var(--card-w) / -2)";
    card.style.top = "";
    card.style.position = "";
    card.style.transform = "";

    // Лицом вверх
    const inner = card.querySelector(".card-3d");
    if (inner) {
      gsap.set(inner, { rotationY: 180 });
    }
    // Стартовая точка — layout выставит финальные x/y/rotation/scale
    gsap.set(card, { x: 0, y: 0, rotation: 0, scale: 1.28, zIndex: 50 + index });

    if (card.draggableInstance) {
      card.draggableInstance.enable();
    }
  });

  // Веер пересчитывает координаты всех карт (старых и новых)
  updatePlayerHandLayout();
  setTimeout(() => {
    // Фиксируем original* после раскладки, чтобы drag возвращал в правильную точку
    Array.from(playerHand.querySelectorAll(".playing-card")).forEach((c) => {
      c.originalX = gsap.getProperty(c, "x") || 0;
      c.originalY = gsap.getProperty(c, "y") || 0;
      c.originalRotation = gsap.getProperty(c, "rotation") || 0;
    });
    makeHandDraggable();
  }, 350);

  setTimeout(() => {
    cardsInHand = playerHand.querySelectorAll(".playing-card").length;
    botCardsInHand = opponentHand.querySelectorAll(".playing-card").length;
    console.log(`Игрок взял карты. Теперь карт в руке: ${cardsInHand}`);

    currentReceiver = "player";
    isDealing = false;
    currentAttacker = "bot";

    if (isOnlineMatch) {
      updateTurnUI();
      return; // game:round_ended с сервера
    }
    if (checkGameOver()) return;
    startAutoDeal();
    setTimeout(botAttack, 900);
  }, cardsToTake.length * 50 + 400);
}

/** Раскладка верхнего веера соперника (бот в тренировке / второй игрок в онлайне) */
function updateBotHandLayout() {
  const botCards = Array.from(opponentHand.querySelectorAll(".playing-card"));
  const totalCards = botCards.length;
  if (totalCards === 0) return;

  const mid = (totalCards - 1) / 2;

  // Адаптивный шаг: сжимаем карты, если их больше 6, чтобы они не вылезали за аватарку
  const stepX = totalCards <= 6 ? 16 : Math.max(6, 96 / totalCards);
  const stepRotation = totalCards <= 6 ? 9 : Math.max(4, 54 / totalCards);
  const stepY = totalCards <= 6 ? 4 : Math.max(1.5, 20 / totalCards);

  botCards.forEach((card, index) => {
    const t = index - mid;
    
    // Принудительно выравниваем каждую карту по центру контейнера
    card.style.left = "50%";
    card.style.marginLeft = "calc(var(--card-w) / -2)";

    const newX = t * stepX;           
    const newY = -Math.abs(t) * stepY; 
    const newRotation = -t * stepRotation;   

    gsap.to(card, {
      x: newX,
      y: newY,
      rotation: newRotation,
      scale: 0.50,            
      zIndex: 3 + index,      
      duration: 0.4,         
      ease: "power2.out"
    });
  });
}

function sendTableToDiscard(thenBotAttacks = true) {
  if (tableCards.length === 0) return;

  const discardPile = document.getElementById("discard-pile");
  const cardsToDiscard = tableCards.map(c => c.element);
  
  tableCards = [];
  tableCardsCount = 0;

  cardsToDiscard.forEach((card, index) => {
    // Сначала считаем текущую позицию относительно discard-pile
    const cardRect = card.getBoundingClientRect();
    const pileRect = discardPile.getBoundingClientRect();
    
    discardPile.appendChild(card);
    card.style.pointerEvents = "none";
    card.style.left = "50%";
    card.style.marginLeft = "calc(var(--card-w) / -2)";
    card.style.top = "0";
    
    // Стартовая позиция = где карта была на экране
    const startX = cardRect.left + cardRect.width / 2 - (pileRect.left + pileRect.width / 2);
    const startY = cardRect.top + cardRect.height / 2 - (pileRect.top + pileRect.height / 2);

    const offsetX = (index % 3) * 5 - 5;
    const offsetY = Math.floor(index / 3) * 4;
    const rot = (Math.random() * 12 - 6);

    gsap.set(card, { x: startX, y: startY, scale: 0.85, rotation: gsap.getProperty(card, "rotation") || 0 });

    gsap.to(card, {
      x: offsetX,
      y: offsetY,
      rotation: rot,
      scale: 0.50,
      duration: 0.5,
      delay: index * 0.05,
      ease: "power2.inOut"
    });

    // Рубашкой вверх
    const inner = card.querySelector(".card-3d");
    if (inner) {
      gsap.to(inner, { rotationY: 0, duration: 0.35, delay: index * 0.05 });
    }
  });

  discardCards.push(...cardsToDiscard);

  setTimeout(() => {
    if (isOnlineMatch) {
      updateTurnUI();
      return; // game:round_ended
    }
    if (checkGameOver()) return;

    if (thenBotAttacks) {
      currentAttacker = "bot";
      console.log("Бито! Ход переходит боту.");
      startAutoDeal();
      setTimeout(botAttack, 800);
    } else {
      currentAttacker = "player";
      console.log("Бито! Ход снова у игрока.");
      startAutoDeal();
    }
  }, cardsToDiscard.length * 50 + 550);
}

function botAttack() {
  // Сетевой матч: ИИ отключён — ждём пакет хода соперника
  if (isOnlineMatch) {
    console.log("Ожидание сетевого пакета хода от Игрок_777...");
    return;
  }

  // Пока идёт раздача — бот не ходит
  if (isDealing) {
    console.log("Раздача ещё идёт, атака бота отложена");
    setTimeout(botAttack, 200);
    return;
  }

  const botCards = Array.from(opponentHand.querySelectorAll(".playing-card")).filter(c => {
    return !tableCards.some(tc => tc.element === c);
  });

  if (botCards.length === 0) {
    console.log("У бота нет карт для атаки");
    currentAttacker = "player";
    return;
  }

  // Бот ходит самой младшей не-козырной картой, если есть, иначе младшим козырем
  let attackCard = null;
  let bestVal = Infinity;

  botCards.forEach(card => {
    const isTrump = card.dataset.suit === trumpSuit;
    const val = rankValues[card.dataset.rank] + (isTrump ? 50 : 0);
    if (val < bestVal) {
      bestVal = val;
      attackCard = card;
    }
  });

  if (!attackCard) return;

  // Запоминаем текущую визуальную позицию карты (из веера бота)
  const cardRect = attackCard.getBoundingClientRect();
  const tableElement = document.querySelector(".table");
  const tableRect = tableElement.getBoundingClientRect();

  // Переносим в DOM стола
  tableElement.appendChild(attackCard);
  attackCard.style.pointerEvents = "none";
  attackCard.style.left = "50%";
  attackCard.style.marginLeft = "calc(var(--card-w) / -2)";
  attackCard.style.top = "0";

  // Стартовая позиция = где карта была на экране (относительно центра стола)
  const startX = cardRect.left + cardRect.width / 2 - (tableRect.left + tableRect.width / 2);
  const startY = cardRect.top + cardRect.height / 2 - (tableRect.top + tableRect.height / 2);

  // Сбрасываем старые трансформы руки и ставим стартовую точку
  gsap.killTweensOf(attackCard);
  gsap.set(attackCard, {
    x: startX,
    y: startY,
    rotation: gsap.getProperty(attackCard, "rotation") || 0,
    scale: 0.50,
    zIndex: 20
  });

  tableCards.push({
    element: attackCard,
    isAttack: true,
    defendedBy: null
  });
  tableCardsCount++;

  // Переворачиваем карту лицом
  const card3d = attackCard.querySelector(".card-3d");
  if (card3d) {
    gsap.to(card3d, { rotateY: 180, duration: 0.3 });
  }

  // Обновляем веер бота (без этой карты) и анимируем карту на стол
  updateBotHandLayout();
  // Небольшая задержка, чтобы DOM и стили успели примениться, затем летим на финальную позицию
  requestAnimationFrame(() => {
    repositionTableCards();
  });
  console.log("Бот ходит картой:", attackCard.dataset.rank, attackCard.dataset.suit);

  // Показываем кнопку «Взять» — игрок может взять карты, если не может/не хочет отбиваться
  botIsTaking = false;
  isBitoPending = false;
  setTimeout(() => {
    // Если стол ещё не полностью защищён — даём возможность взять
    if (!isTableFullyDefended()) {
      showActionButton("Взять");
      botIsTaking = true;
    }
  }, 600);
}


// Возврат в главное меню
function goToMainMenu() {
  document.querySelector(".table")?.classList.remove("game-active");

  if (socket && socket.connected && myTableId) {
    socket.emit("table:leave");
  }
  myTableId = null;
  myNetworkRole = null;
  isOnlineMatch = false;
  isPlayerReady = false;
  isOpponentReady = false;
  hasOpponentConnected = false;
  if (onlineJoinTimer) { clearTimeout(onlineJoinTimer); onlineJoinTimer = null; }
  if (onlineReadyTimer) { clearTimeout(onlineReadyTimer); onlineReadyTimer = null; }
  resetGame();
  setOpponentBotUI();
  const sm = document.getElementById("start-menu");
  if (sm) {
    sm.style.display = "flex";
    sm.style.opacity = "1";
    gsap.set(sm, { opacity: 1 });
  }
  const op = document.getElementById("opponent-profile");
  if (op) {
    gsap.set(op, { opacity: 0 });
  }
  const playBtn = document.getElementById("play-btn");
  if (playBtn) {
    playBtn.disabled = false;
  }
  const go = document.getElementById("game-over");
  if (go) {
    go.style.display = "none";
    go.style.opacity = "0";
  }
  const bm = document.getElementById("burger-modal");
  if (bm) {
    bm.style.display = "none";
  }
  if (lobbyModal) {
    lobbyModal.style.display = "none";
    lobbyModal.setAttribute("aria-hidden", "true");
  }
  if (createGameModal) {
    createGameModal.style.display = "none";
    createGameModal.setAttribute("aria-hidden", "true");
  }
  const turnEl = document.getElementById("turn-status");
  if (turnEl) {
    turnEl.style.display = "none";
    turnEl.textContent = "";
  }
}

// Кнопки экрана окончания игры
document.getElementById("restart-btn")?.addEventListener("click", () => {
  resetGame();
  setTimeout(() => startAutoDeal(), 300);
});

document.getElementById("menu-btn")?.addEventListener("click", goToMainMenu);

// ===== Бургер-меню =====
const burgerBtn = document.getElementById("burger-btn");
const burgerModal = document.getElementById("burger-modal");
const burgerCloseBtn = document.getElementById("burger-close-btn");
const toMainMenuBtn = document.getElementById("to-main-menu-btn");

burgerBtn?.addEventListener("click", () => {
  if (!burgerModal) return;
  burgerModal.style.display = "flex";
  gsap.fromTo(burgerModal, { opacity: 0 }, { opacity: 1, duration: 0.2 });
});

burgerCloseBtn?.addEventListener("click", () => {
  if (!burgerModal) return;
  gsap.to(burgerModal, {
    opacity: 0,
    duration: 0.15,
    onComplete() { burgerModal.style.display = "none"; }
  });
});

// Клик по затемнению закрывает модалку
burgerModal?.addEventListener("click", (e) => {
  if (e.target === burgerModal) {
    gsap.to(burgerModal, {
      opacity: 0,
      duration: 0.15,
      onComplete() { burgerModal.style.display = "none"; }
    });
  }
});

toMainMenuBtn?.addEventListener("click", goToMainMenu);


// Демо: блокируем онлайн и настройки
if (typeof DEMO_ONLY_TRAINING !== "undefined" && DEMO_ONLY_TRAINING) {
  document.getElementById("play-match-btn")?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    console.log("[demo] Играть / онлайн отключены — только Тренировка");
  }, true);
  document.getElementById("settings-btn")?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
  }, true);
  document.getElementById("header-settings-btn")?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
  }, true);
  document.getElementById("tab-settings-btn")?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
  }, true);
}
