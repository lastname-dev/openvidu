import { Injectable } from '@angular/core';
import {
	Connection,
	OpenVidu,
	OpenViduError,
	OpenViduErrorName,
	Publisher,
	PublisherProperties,
	Session,
	SignalOptions
} from 'openvidu-browser';

import { LoggerService } from '../logger/logger.service';

import { ILogger } from '../../models/logger.model';
import { Signal } from '../../models/signal.model';
import { OpenViduAngularConfigService } from '../config/openvidu-angular.config.service';
import { PlatformService } from '../platform/platform.service';
import { DeviceService } from '../device/device.service';
import { CameraType } from '../../models/device.model';
import { VideoType } from '../../models/video-type.model';
import { ParticipantService } from '../participant/participant.service';

@Injectable({
	providedIn: 'root'
})
export class OpenViduService {
	protected OV: OpenVidu = null;
	protected OVScreen: OpenVidu = null;
	protected webcamSession: Session = null;
	protected screenSession: Session = null;
	protected videoSource = undefined;
	protected audioSource = undefined;
	protected log: ILogger;

	constructor(
		protected openviduAngularConfigSrv: OpenViduAngularConfigService,
		protected platformService: PlatformService,
		protected loggerSrv: LoggerService,
		private participantService: ParticipantService,
		protected deviceService: DeviceService
	) {
		this.log = this.loggerSrv.get('OpenViduService');
	}

	initialize() {
		this.OV = new OpenVidu();
		if (this.openviduAngularConfigSrv.isProduction()) this.OV.enableProdMode();
		this.webcamSession = this.OV.initSession();

		// Initialize screen session only if it is not mobile platform
		if (!this.platformService.isMobile()) {
			this.OVScreen = new OpenVidu();
			if (this.openviduAngularConfigSrv.isProduction()) this.OVScreen.enableProdMode();
			this.screenSession = this.OVScreen.initSession();
		}
	}

	getSession(): Session {
		return this.getWebcamSession();
	}

	getWebcamSession(): Session {
		return this.webcamSession;
	}

	isWebcamSessionConnected(): boolean {
		return !!this.webcamSession.capabilities;
	}

	getScreenSession(): Session {
		return this.screenSession;
	}

	isScreenSessionConnected(): boolean {
		return !!this.screenSession.capabilities;
	}

	async connectSession(session: Session, token: string): Promise<void> {
		if (!!token && session) {
			const nickname = this.participantService.getMyNickname();
			const participantId = this.participantService.getLocalParticipant().id;
			if (session === this.webcamSession) {
				this.log.d('Connecting webcam session');
				await this.webcamSession.connect(token, {
					clientData: nickname,
					participantId,
					type: VideoType.CAMERA
				});
				this.participantService.setMyCameraConnectionId(this.webcamSession.connection.connectionId);
			} else if (session === this.screenSession) {
				this.log.d('Connecting screen session');
				await this.screenSession.connect(token, {
					clientData: `${nickname}_${VideoType.SCREEN}`,
					participantId,
					type: VideoType.SCREEN
				});

				this.participantService.setMyScreenConnectionId(this.screenSession.connection.connectionId);
			}
		}
	}

	disconnect() {
		this.disconnectSession(this.webcamSession);
		this.disconnectSession(this.screenSession);
		this.videoSource = undefined;
		this.audioSource = undefined;
		// this.stopTracks(this.participantService.getMyCameraPublisher()?.stream?.getMediaStream());
		// this.stopTracks(this.participantService.getMyScreenPublisher()?.stream?.getMediaStream());
	}

	/**
	 * Initialize a publisher checking devices saved on storage or if participant have devices available.
	 */
	async initDefaultPublisher(targetElement: string | HTMLElement): Promise<Publisher> {
		const hasVideoDevices = this.deviceService.hasVideoDeviceAvailable();
		const hasAudioDevices = this.deviceService.hasAudioDeviceAvailable();
		const isVideoActive = !this.deviceService.isVideoMuted();
		const isAudioActive = !this.deviceService.isAudioMuted();

		let videoSource = null;
		let audioSource = null;

		if (hasVideoDevices) {
			// Video is active, assign the device selected
			videoSource = this.deviceService.getCameraSelected().device;
		} else if (!isVideoActive && hasVideoDevices) {
			// Video is muted, assign the default device
			// videoSource = undefined;
		}

		if (hasAudioDevices) {
			// Audio is active, assign the device selected
			audioSource = this.deviceService.getMicrophoneSelected().device;
		} else if (!isAudioActive && hasAudioDevices) {
			// Audio is muted, assign the default device
			// audioSource = undefined;
		}

		// const videoSource = publishVideo ? this.deviceService.getCameraSelected().device : false;
		// const audioSource = publishAudio ? this.deviceService.getMicrophoneSelected().device : false;
		const mirror = this.deviceService.getCameraSelected() && this.deviceService.getCameraSelected().type === CameraType.FRONT;
		const properties: PublisherProperties = {
			videoSource,
			audioSource,
			publishVideo: isVideoActive,
			publishAudio: isAudioActive,
			mirror
		};
		if (hasVideoDevices || hasAudioDevices) {
			const publisher = await this.initPublisher(targetElement, properties);
			this.participantService.setMyCameraPublisher(publisher);
			this.participantService.updateLocalParticipant();
			return publisher;
		} else {
			this.participantService.setMyCameraPublisher(null);
		}
	}

	async initPublisher(targetElement: string | HTMLElement, properties: PublisherProperties): Promise<Publisher> {
		this.log.d('Initializing publisher with properties: ', properties);
		return await this.OV.initPublisherAsync(targetElement, properties);
	}

	async publish(publisher: Publisher): Promise<void> {
		if (!!publisher) {
			if (publisher === this.participantService.getMyCameraPublisher()) {
				if (this.webcamSession?.capabilities?.publish) {
					return await this.webcamSession.publish(publisher);
				}
				this.log.e('Webcam publisher cannot be published');
			} else if (publisher === this.participantService.getMyScreenPublisher()) {
				if (this.screenSession?.capabilities?.publish) {
					return await this.screenSession.publish(publisher);
				}
				this.log.e('Screen publisher cannot be published');
			}
		}
	}

	unpublish(publisher: Publisher): void {
		if (!!publisher) {
			if (publisher === this.participantService.getMyCameraPublisher()) {
				this.publishAudio(this.participantService.getMyScreenPublisher(), this.participantService.hasCameraAudioActive());
				this.webcamSession.unpublish(publisher);
			} else if (publisher === this.participantService.getMyScreenPublisher()) {
				this.screenSession.unpublish(publisher);
			}
		}
	}

	publishVideo(publisher: Publisher, value: boolean): void {
		if (!!publisher) {
			publisher.publishVideo(value);
			this.participantService.updateLocalParticipant();
		}
	}

	publishAudio(publisher: Publisher, value: boolean): void {
		if (!!publisher) {
			publisher.publishAudio(value);
			this.participantService.updateLocalParticipant();
		}
	}

	// TODO: Remove this method when replaceTrack issue is fixed
	// https://github.com/OpenVidu/openvidu/pull/700
	republishTrack(properties: PublisherProperties): Promise<void> {
		const { videoSource, audioSource, mirror } = properties;
		return new Promise(async (resolve, reject) => {
			if (!!videoSource) {
				this.log.d('Replacing video track ' + videoSource);
				this.videoSource = videoSource;
			}
			if (!!audioSource) {
				this.log.d('Replacing audio track ' + audioSource);
				this.audioSource = audioSource;
			}
			this.destroyPublisher(this.participantService.getMyCameraPublisher());
			const properties: PublisherProperties = {
				videoSource: this.videoSource,
				audioSource: this.audioSource,
				publishVideo: this.participantService.hasCameraVideoActive(),
				publishAudio: this.participantService.hasCameraAudioActive(),
				mirror
			};

			const publisher = await this.initPublisher(undefined, properties);
			this.participantService.setMyCameraPublisher(publisher);

			publisher.once('streamPlaying', () => {
				this.participantService.setMyCameraPublisher(publisher);
				resolve();
			});

			publisher.once('accessDenied', () => {
				reject();
			});
		});
	}

	sendSignal(type: Signal, connections?: Connection[], data?: any): void {
		const signalOptions: SignalOptions = {
			data: JSON.stringify(data),
			type: type,
			to: connections && connections.length > 0 ? connections : undefined
		};
		this.webcamSession.signal(signalOptions);

		// TODO: Check if it is necessary
		// if (type === Signal.NICKNAME_CHANGED && !!this.getScreenSession().connection) {
		// 	signalOptions.data = JSON.stringify({ clientData: this.participantService.getScreenNickname() });
		// 	this.getScreenSession()?.signal(signalOptions);
		// }
	}

	async replaceTrack(videoType: VideoType, props: PublisherProperties) {
		try {
			this.log.d(`Replacing ${videoType} track`, props);

			if (videoType === VideoType.CAMERA) {
				//TODO: Uncomment this section when replaceTrack issue is fixed
				// https://github.com/OpenVidu/openvidu/pull/700
				throw 'Replace track feature has a bug. We are trying to fix it';
				// let mediaStream: MediaStream;
				// const oldMediaStream = this.participantService.getMyCameraPublisher().stream.getMediaStream();
				// const isFirefoxPlatform = this.platformService.isFirefox();
				// const isReplacingAudio = !!props.audioSource;
				// const isReplacingVideo = !!props.videoSource;

				// if (isReplacingVideo) {
				// 	if (isFirefoxPlatform) {
				// 		// Firefox throw an exception trying to get a new MediaStreamTrack if the older one is not stopped
				// 		// NotReadableError: Concurrent mic process limit. Stopping tracks before call to getUserMedia
				// 		oldMediaStream.getVideoTracks()[0].stop();
				// 	}
				// 	mediaStream = await this.createMediaStream(props);
				// 	// Replace video track
				// 	const videoTrack: MediaStreamTrack = mediaStream.getVideoTracks()[0];
				// 	await this.participantService.getMyCameraPublisher().replaceTrack(videoTrack);
				// } else if (isReplacingAudio) {
				// 	if (isFirefoxPlatform) {
				// 		// Firefox throw an exception trying to get a new MediaStreamTrack if the older one is not stopped
				// 		// NotReadableError: Concurrent mic process limit. Stopping tracks before call to getUserMedia
				// 		oldMediaStream.getAudioTracks()[0].stop();
				// 	}
				// 	mediaStream = await this.createMediaStream(props);
				// 	// Replace audio track
				// 	const audioTrack: MediaStreamTrack = mediaStream.getAudioTracks()[0];
				// 	await this.participantService.getMyCameraPublisher().replaceTrack(audioTrack);
				// }
			} else if (videoType === VideoType.SCREEN) {
				let newScreenMediaStream;
				try {
					newScreenMediaStream = await this.OVScreen.getUserMedia(props);
					this.participantService.getMyScreenPublisher().stream.getMediaStream().getVideoTracks()[0].stop();
					await this.participantService.getMyScreenPublisher().replaceTrack(newScreenMediaStream.getVideoTracks()[0]);
				} catch (error) {
					this.log.w('Cannot create the new MediaStream', error);
				}
			}
		} catch (error) {
			this.log.e('Error replacing track ', error);
		}
	}

	private destroyPublisher(publisher: Publisher): void {
		if (!!publisher) {
			if (publisher.stream.getWebRtcPeer()) {
				publisher.stream.disposeWebRtcPeer();
			}
			publisher.stream.disposeMediaStream();
			if (publisher.id === this.participantService.getMyCameraPublisher().id) {
				this.participantService.setMyCameraPublisher(publisher);
			} else if (publisher.id === this.participantService.getMyScreenPublisher().id) {
				this.participantService.setMyScreenPublisher(publisher);
			}
		}
	}

	private async createMediaStream(pp: PublisherProperties): Promise<MediaStream> {
		let mediaStream: MediaStream;
		const isFirefoxPlatform = this.platformService.isFirefox();
		const isReplacingAudio = !!pp.audioSource;
		const isReplacingVideo = !!pp.videoSource;

		try {
			mediaStream = await this.OV.getUserMedia(pp);
		} catch (error) {
			if ((<OpenViduError>error).name === OpenViduErrorName.DEVICE_ACCESS_DENIED) {
				if (isFirefoxPlatform) {
					this.log.w('The device requested is not available. Restoring the older one');
					// The track requested is not available so we are getting the old tracks ids for recovering the track
					if (isReplacingVideo) {
						pp.videoSource = this.deviceService.getCameraSelected().device;
					} else if (isReplacingAudio) {
						pp.audioSource = this.deviceService.getMicrophoneSelected().device;
					}
					mediaStream = await this.OV.getUserMedia(pp);
					// TODO show error alert informing that the new device is not available
				}
			}
		} finally {
			return mediaStream;
		}
	}

	needSendNicknameSignal(): boolean {
		let oldNickname: string;
		try {
			const connData = JSON.parse(this.webcamSession.connection.data.split('%/%')[0]);
			oldNickname = connData.clientData;
		} catch (error) {
			this.log.e(error);
		}
		return oldNickname !== this.participantService.getMyNickname();
	}

	isMyOwnConnection(connectionId: string): boolean {
		return (
			this.webcamSession?.connection?.connectionId === connectionId || this.screenSession?.connection?.connectionId === connectionId
		);
	}

	getRemoteConnections(): Connection[] {
		// Avoid screen connections
		const remoteCameraConnections: Connection[] = Array.from(this.webcamSession.remoteConnections.values()).filter((conn) => {
			let type: VideoType;
			type = JSON.parse(conn.data).type;
			return type !== VideoType.SCREEN;
		});
		return remoteCameraConnections;
	}

	private disconnectSession(session: Session) {
		if (session) {
			if (session.sessionId === this.webcamSession?.sessionId) {
				this.log.d('Disconnecting webcam session');
				this.webcamSession?.disconnect();
				this.webcamSession = null;
			} else if (session.sessionId === this.screenSession?.sessionId) {
				this.log.d('Disconnecting screen session');
				this.screenSession?.disconnect();
				this.screenSession = null;
			}
		}
	}

	// private stopTracks(mediaStream: MediaStream) {
	// 	if (mediaStream) {
	// 		mediaStream?.getAudioTracks().forEach((track) => track.stop());
	// 		mediaStream?.getVideoTracks().forEach((track) => track.stop());
	// 		// this.webcamMediaStream?.getAudioTracks().forEach((track) => track.stop());
	// 	}
	// }
}