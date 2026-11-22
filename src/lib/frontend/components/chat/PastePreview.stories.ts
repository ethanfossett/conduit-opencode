import type { Meta, StoryObj } from "@storybook/svelte-vite";
import type { PendingAttachment } from "../../types.js";
import PastePreview from "./PastePreview.svelte";

const meta = {
	title: "Chat/PastePreview",
	component: PastePreview,
	tags: ["autodocs"],
} satisfies Meta<typeof PastePreview>;

export default meta;
type Story = StoryObj<typeof meta>;

// A tiny 1x1 red PNG as base64 for mock thumbnails
const RED_PIXEL =
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";
// A tiny 1x1 blue PNG
const BLUE_PIXEL =
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPj/HwADBwIAMCbHYQAAAABJRU5ErkJggg==";
// A tiny 1x1 green PNG
const GREEN_PIXEL =
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const mockAttachments: PendingAttachment[] = [
	{
		id: "img-1",
		dataUrl: RED_PIXEL,
		name: "screenshot.png",
		size: 24576,
		mime: "image/png",
		kind: "image",
	},
	{
		id: "img-2",
		dataUrl: BLUE_PIXEL,
		name: "diagram-architecture-overview.png",
		size: 102400,
		mime: "image/png",
		kind: "image",
	},
	{
		id: "img-3",
		dataUrl: GREEN_PIXEL,
		name: "photo.jpg",
		size: 512000,
		mime: "image/jpeg",
		kind: "image",
	},
];

const mockMixedAttachments: PendingAttachment[] = [
	...mockAttachments.slice(0, 1),
	{
		id: "file-1",
		dataUrl: "data:application/pdf;base64,JVBERi0xLjc=",
		name: "quarterly-report-2026.pdf",
		size: 843776,
		mime: "application/pdf",
		kind: "file",
	},
];

export const WithImages: Story = {
	args: {
		attachments: mockAttachments,
		onRemove: (id: string) => console.log("Remove attachment:", id),
	},
};

export const SingleImage: Story = {
	args: {
		attachments: [mockAttachments[0]],
		onRemove: (id: string) => console.log("Remove attachment:", id),
	},
};

export const MixedFiles: Story = {
	args: {
		attachments: mockMixedAttachments,
		onRemove: (id: string) => console.log("Remove attachment:", id),
	},
};

export const Empty: Story = {
	args: {
		attachments: [],
		onRemove: (id: string) => console.log("Remove attachment:", id),
	},
};
