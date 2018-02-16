import { reaction } from 'mobx';
import Mousetrap from 'mousetrap';

import Action from '../shared/action';
import webrtc from './helper/webrtc';
import skyway from './helper/skyway';

class ConfAction extends Action {
  constructor(store) {
    super(store);

    const { user, room, ui } = this.store;

    reaction(
      () => [user.videoDeviceId, user.audioDeviceId],
      async ([videoDeviceId, audioDeviceId]) => {
        // stop previous stream if exist
        if (room.localStream instanceof MediaStream) {
          webrtc.stopStream(room.localStream);
        }

        const stream = await webrtc
          .getUserMedia({ videoDeviceId, audioDeviceId })
          .catch(err => ui.handleGetUserMediaError(err));

        if (ui.isError) {
          return;
        }

        // once got media, it's ready
        ui.isAppReady = true;
        stream.peerId = user.peerId;
        user.isVideoMuted && webrtc.toggleMuteVideoTracks(stream, true);
        user.isAudioMuted && webrtc.toggleMuteAudioTracks(stream, true);

        room.localStream = stream;
      }
    );

    reaction(
      () => user.isVideoMuted,
      isMuted => webrtc.toggleMuteVideoTracks(room.localStream, isMuted)
    );
    reaction(
      () => user.isAudioMuted,
      isMuted => webrtc.toggleMuteAudioTracks(room.localStream, isMuted)
    );
  }

  async onLoad({ roomType, roomName }) {
    const { user, ui } = this.store;

    ui.setRoom({ roomType, roomName });

    const devices = await webrtc
      .getUserDevices()
      .catch(err => ui.handleUserError(err));

    if (ui.isError) {
      return;
    }

    // this triggers reaction and get user media
    user.updateDevices(devices);

    navigator.mediaDevices.addEventListener('devicechange', async () => {
      const devices = await webrtc
        .getUserDevices()
        .catch(err => ui.handleUserError(err));

      if (ui.isError) {
        return;
      }

      user.updateDevices(devices);
    });
    Mousetrap.bind(['command+e', 'ctrl+e'], () => {
      user.isVideoMuted = !user.isVideoMuted;
      return false;
    });
    Mousetrap.bind(['command+d', 'ctrl+d'], () => {
      user.isAudioMuted = !user.isAudioMuted;
      return false;
    });
  }

  async onClickJoinRoom() {
    const { ui, room, user } = this.store;

    const peer = await skyway.initPeer().catch(err => ui.handleAppError(err));

    if (ui.isError) {
      return;
    }

    peer.on('error', err => ui.handleSkyWayPeerError(err));
    user.peerId = peer.id;

    const confRoom = peer.joinRoom(`${ui.roomType}/${ui.roomName}`, {
      mode: ui.roomType,
      stream: room.localStream,
    });
    this._onRoomJoin(confRoom);

    ui.isSettingOpen = false;
  }

  async onChatEnterKeyDown() {
    const { chat, user, room, ui } = this.store;
    if (chat.bufferText.length === 0) {
      return;
    }

    const blob = await webrtc
      .snapVideoStream(room.localStream, 'image/jpeg', 0.5)
      .catch(err => ui.handleAppError(err));

    if (ui.isError) {
      return;
    }

    const payload = {
      peerId: user.peerId,
      text: chat.bufferText,
      blob,
      timestamp: Date.now(),
    };
    // sync local
    chat.addMessage(payload, user.dispName);
    // this triggers sync remotes
    chat.lastMessage = payload;
    chat.bufferText = '';
  }

  startScreenShare() {
    const { ui } = this.store;
    ui.isScreenSharing = true;
  }
  stopScreenShare() {
    const { ui } = this.store;
    ui.isScreenSharing = false;
  }

  _onRoomJoin(confRoom) {
    const { ui, user, room, chat } = this.store;
    ui.isRoomJoin = true;

    confRoom.on('stream', stream => this._onRoomAddStream(stream, confRoom));
    confRoom.on('removeStream', stream => this._onRoomRemoveStream(stream));
    confRoom.on('peerLeave', peerId => this._onRoomPeerLeave(peerId));
    confRoom.on('data', data => this._onRoomData(data));

    reaction(
      () => room.localStream,
      () => confRoom.replaceStream(room.localStream)
    );
    reaction(
      () => user.syncState,
      state => confRoom.send({ type: 'sync', payload: state })
    );
    reaction(
      () => chat.lastMessage,
      msg => confRoom.send({ type: 'chat', payload: msg })
    );
  }
  _onRoomAddStream(stream, confRoom) {
    const { room, user } = this.store;
    room.remoteStreams.push(stream);

    // return back state as welcome message
    confRoom.send({ type: 'sync', payload: user.syncState });
  }
  _onRoomRemoveStream(stream) {
    const { room } = this.store;
    room.removeRemoteStream(stream);
  }
  _onRoomPeerLeave(peerId) {
    const { room } = this.store;
    room.removeRemoteStreamByPeerId(peerId);
  }
  _onRoomData({ _src, data }) {
    const { room, chat } = this.store;
    const { type, payload } = data;
    switch (type) {
      case 'sync': {
        room.syncState.set(payload.peerId, payload);
        break;
      }
      case 'chat': {
        const syncState = room.syncState.get(payload.peerId);
        chat.addMessage(payload, syncState.dispName);
        break;
      }
      default:
        throw new Error(`${type} is not defined as message type`);
    }
  }
}

export default ConfAction;
