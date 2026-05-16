import type fs from "node:fs";
import type prism from "prism-media";

export interface RoleMetadata {
  id: string;
  name: string;
  position: number;
}

export interface UserMetadata {
  userId: string;
  username: string;
  tag: string;
  displayName: string;
  avatarUrl: string;
  bot: boolean;
  roles: RoleMetadata[];
  highestRole: RoleMetadata | null;
  joinedTimestamp: number | null;
}

export interface SegmentState {
  index: number;
  startTime: number;
  endTime: number | null;
  filename: string;
  jsonFilename: string;
  oggStream: prism.opus.OggLogicalBitstream;
  out: fs.WriteStream;
}

export interface SegmentMetadata extends UserMetadata {
  recordingSessionId: string;
  sessionId: string;
  sessionStartTime: number;
  segmentIndex: number;
  segmentMs: number;
  startTime: number;
  endTime: number;
  durationMs: number;
  filename: string;
}

export interface PcmBroadcaster {
  broadcastPcmToWeb?: (chunk: Buffer, userId: string) => void;
  updateActiveUser?: (
    userId: string,
    data: { username: string; avatar: string; speaking: boolean },
  ) => void;
}
