/**
 * Domain types — the API contract, mirrored from the mobile app's `src/types`.
 * Kept in sync so the mobile real client and this server agree on shapes.
 */

export type Role = "TESTER" | "FOUNDER";
export type BadgeTier = "NONE" | "VERIFIED" | "SENIOR" | "EXPERT";
export type CampaignStatus = "DRAFT" | "MATCHING" | "UPLOADED" | "ACTIVE" | "COMPLETE";
export type CycleStatus =
  | "MATCHED" | "INVITED" | "INSTALLED" | "ACTIVE" | "COMPLETED" | "DROPPED";
export type RewardType = "PREMIUM_ACCESS" | "CREDITS" | "STIPEND";
export type CheckInStatus = "PENDING" | "SENT" | "RESPONDED" | "MISSED";
export type FounderAppStatus = "DRAFT" | "ENROLLING" | "INVITED" | "COMPLETE";
export type EnrollmentStatus = "ENROLLED" | "TESTING" | "COMPLETED" | "DROPPED";
export type NotificationKind = "MATCH" | "BROADCAST" | "REMINDER" | "REWARD" | "SYSTEM";

export const CHECKIN_DAYS = [3, 7, 10, 14] as const;
export type CheckInDay = (typeof CHECKIN_DAYS)[number];

export interface Campaign {
  id: string;
  appName: string;
  packageName: string;
  vertical: string;
  feedbackFocus: string;
  description?: string;
  testersNeeded: number;
  testersMatched: number;
  rewardType: RewardType;
  playStoreUrl?: string;
}

export interface CheckIn {
  id: string;
  dayNumber: CheckInDay;
  scheduledFor: string;
  status: CheckInStatus;
  response?: string;
  respondedAt?: string;
}

export interface InstallProof {
  id: string;
  screenshotUrl: string;
  verified: boolean;
  uploadedAt: string;
}

export interface FeedbackQuestion {
  id: string;
  prompt: string;
  type: "rating" | "text" | "boolean";
}

export interface Feedback {
  answers: Record<string, string | number | boolean>;
  submittedAt: string;
}

export interface DailyCheckIn {
  day: number;
  doneAt?: string;
}

export interface Cycle {
  id: string;
  campaign: Campaign;
  status: CycleStatus;
  gmailForCampaign: string;
  optInAt?: string;
  completesAt?: string;
  completedAt?: string;
  founderRating?: number;
  rewardClaimed?: boolean;
  checkIns: CheckIn[];
  dailyCheckIns?: DailyCheckIn[];
  proof?: InstallProof;
  feedback?: Feedback;
}

export interface TesterProfile {
  id: string;
  name: string;
  email: string;
  vertical: string;
  categories: string[];
  verified: boolean;
  bio?: string;
  reliabilityScore: number;
  acceptedCycles: number;
  completedCycles: number;
  badgeTier: BadgeTier;
  premiumUntil?: string;
  credits: number;
  stipendPending: number;
  publicSlug: string;
}

export interface FounderApp {
  id: string;
  name: string;
  packageName: string;
  vertical: string;
  description?: string;
  feedbackFocus: string;
  playStoreUrl?: string;
  status: FounderAppStatus;
  rewardType: RewardType;
  minTesters: number;
  enrolledCount: number;
  feedbackCount: number;
  startDate?: string;
  publishedAt?: string;
  createdAt: string;
}

export interface Enrollment {
  id: string;
  appId: string;
  testerName: string;
  gmail: string;
  badgeTier: BadgeTier;
  reliabilityScore: number;
  enrolledAt: string;
  dailyDone: number;
  status: EnrollmentStatus;
  feedbackSubmitted: boolean;
  rated: boolean;
}

export interface FounderTesterRow {
  id: string;
  testerName: string;
  appName: string;
  vertical: string;
  status: CycleStatus;
  dayProgress: number;
  reliabilityScore: number;
  badgeTier: BadgeTier;
  rated: boolean;
}

export interface FounderStats {
  appsSubmitted: number;
  activeCampaigns: number;
  testersEngaged: number;
  avgRating: number;
  feedbackReceived: number;
}

export interface Broadcast {
  id: string;
  packageName: string;
  message: string;
  sentAt: string;
}

export interface BroadcastReply {
  id: string;
  broadcastId: string;
  authorName: string;
  authorRole: Role;
  message: string;
  sentAt: string;
}

export interface AppNotification {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  createdAt: string;
  read: boolean;
}
