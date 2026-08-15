import type { SVGProps } from "react";
import {
  Check,
  ChevronDown,
  Copy,
  Globe,
  LoaderCircle,
  LogOut,
  Menu,
  Mic,
  MoreHorizontal,
  Paperclip,
  Pencil,
  PenLine,
  Plus,
  RefreshCw,
  Share2,
  Square,
  Trash2,
  Upload,
  X,
} from "lucide-react";

type CustomIconProps = Omit<SVGProps<SVGSVGElement>, "height" | "width"> & {
  size?: number | string;
};

// ChatGPT composer send mark, using the reference interface's 20px path.
function sendPromptIcon({ size = 20, ...props }: CustomIconProps) {
  return (
    <svg
      {...props}
      data-icon="send-prompt"
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M9 16V6.414L5.707 9.707a1 1 0 1 1-1.414-1.414l5-5 .076-.069a1 1 0 0 1 1.338.069l5 5 .068.076a1 1 0 0 1-1.406 1.406l-.076-.068L11 6.414V16a1 1 0 1 1-2 0" />
    </svg>
  );
}

function codeIcon({ size = 20, ...props }: CustomIconProps) {
  return (
    <svg
      {...props}
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M4.47 6.273a.665.665 0 1 1 1.07.789l-2.212 3.002 2.21 2.95a.665.665 0 0 1-1.065.796l-2.431-3.246a.83.83 0 0 1-.004-.991zM14.606 6.131a.665.665 0 0 1 .93.142l2.43 3.3a.83.83 0 0 1-.003.99l-2.43 3.247a.665.665 0 0 1-1.065-.797l2.209-2.95-2.212-3.001a.666.666 0 0 1 .14-.93M11.059 6.373a.666.666 0 0 1 1.193.586l-3.31 6.734a.665.665 0 1 1-1.194-.587z" />
    </svg>
  );
}

function copyFilledIcon({ size = 20, ...props }: CustomIconProps) {
  return (
    <svg
      {...props}
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="currentColor"
      fillRule="evenodd"
      clipRule="evenodd"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M15.1 1.785a3.065 3.065 0 0 1 3.065 3.066v6.033a3.065 3.065 0 0 1-3.064 3.064h-1.103v1.103a3.065 3.065 0 0 1-3.064 3.064H4.9a3.066 3.066 0 0 1-3.065-3.064V9.018A3.066 3.066 0 0 1 4.9 5.952h1.102V4.851a3.066 3.066 0 0 1 3.065-3.066zM4.9 7.282c-.958 0-1.735.777-1.735 1.736v6.033c0 .958.777 1.734 1.735 1.734h6.034c.957 0 1.734-.776 1.734-1.734V9.018c0-.959-.776-1.736-1.734-1.736zm4.167-4.167c-.958 0-1.735.777-1.735 1.736v1.101h3.602a3.065 3.065 0 0 1 3.064 3.066v3.6h1.103c.957 0 1.734-.776 1.734-1.734V4.85c0-.958-.777-1.735-1.734-1.736z" />
    </svg>
  );
}

function playIcon({ size = 20, ...props }: CustomIconProps) {
  return (
    <svg
      {...props}
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="currentColor"
      fillRule="evenodd"
      clipRule="evenodd"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M4.96 5.226c0-1.521 1.69-2.435 2.963-1.602l7.299 4.772a1.915 1.915 0 0 1 0 3.206l-7.3 4.773c-1.273.832-2.962-.082-2.962-1.604zm1.33 9.545c0 .465.516.745.905.49l7.3-4.772a.585.585 0 0 0 0-.98l-7.3-4.772a.585.585 0 0 0-.905.49z" />
    </svg>
  );
}

function htmlPreviewIcon({ size = 20, ...props }: CustomIconProps) {
  return (
    <svg
      {...props}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M12.034 12.681a.498.498 0 0 1 .647-.647l9 3.5a.5.5 0 0 1-.033.943l-3.444 1.068a1 1 0 0 0-.66.66l-1.067 3.443a.5.5 0 0 1-.943.033z"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
      <path
        d="M21 11V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h6"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
    </svg>
  );
}

function fullscreenIcon({ size = 20, ...props }: CustomIconProps) {
  return (
    <svg
      {...props}
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M4.335 11a.665.665 0 0 1 1.33 0v3.335H9l.134.014a.665.665 0 0 1 0 1.302L9 15.665H5A.665.665 0 0 1 4.335 15zm10-2V5.665H11a.665.665 0 0 1 0-1.33h4l.134.014c.303.062.531.33.531.651v4a.665.665 0 1 1-1.33 0" />
    </svg>
  );
}

// ChatGPT compose mark, using the reference interface's 20px path.
function newChatIcon({ size = 20, ...props }: CustomIconProps) {
  return (
    <svg
      {...props}
      data-icon="new-chat"
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M8.167 2.501a.665.665 0 0 1 0 1.33H5.834a2 2 0 0 0-2.002 2.002v8.333c0 1.106.896 2.002 2.002 2.002h8.333a2 2 0 0 0 2.002-2.002v-2.333a.665.665 0 0 1 1.33 0v2.333a3.33 3.33 0 0 1-3.332 3.332H5.834a3.33 3.33 0 0 1-3.332-3.332V5.833a3.333 3.333 0 0 1 3.332-3.332z" />
      <path
        fillRule="evenodd"
        d="M13.427 3.104a2.451 2.451 0 0 1 3.46 3.472l-5.163 5.203a3.13 3.13 0 0 1-1.55.853l-2.386.524a.815.815 0 0 1-.97-.971l.525-2.38c.13-.59.429-1.131.86-1.556zm2.512.953a1.12 1.12 0 0 0-1.579-.006L9.136 9.197c-.247.244-.42.554-.495.894l-.351 1.594 1.598-.352c.338-.074.648-.245.892-.49l5.162-5.204a1.12 1.12 0 0 0-.003-1.582"
        clipRule="evenodd"
      />
    </svg>
  );
}

// ChatGPT sidebar panel mark, using the reference interface's 20px filled path.
function sidebarToggleIcon({ size = 20, ...props }: CustomIconProps) {
  return (
    <svg
      {...props}
      data-icon="sidebar-toggle"
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M6.835 4c-.451.004-.82.012-1.137.038-.386.032-.659.085-.876.162l-.2.086c-.44.224-.807.564-1.063.982l-.103.184c-.126.247-.206.562-.248 1.076-.043.523-.043 1.19-.043 2.135v2.664c0 .944 0 1.612.043 2.135.042.515.122.829.248 1.076l.103.184c.256.418.624.758 1.063.982l.2.086c.217.077.49.13.876.162.316.026.685.034 1.136.038zm11.33 7.327c0 .922 0 1.654-.048 2.243-.043.522-.125.977-.305 1.395l-.082.177a4 4 0 0 1-1.473 1.593l-.276.155c-.465.237-.974.338-1.57.387-.59.048-1.322.048-2.244.048H7.833c-.922 0-1.654 0-2.243-.048-.522-.042-.977-.126-1.395-.305l-.176-.082a4 4 0 0 1-1.594-1.473l-.154-.275c-.238-.466-.34-.975-.388-1.572-.048-.589-.048-1.32-.048-2.243V8.663c0-.922 0-1.654.048-2.243.049-.597.15-1.106.388-1.571l.154-.276a4 4 0 0 1 1.594-1.472l.176-.083c.418-.18.873-.263 1.395-.305.589-.048 1.32-.048 2.243-.048h4.334c.922 0 1.654 0 2.243.048.597.049 1.106.15 1.571.388l.276.154a4 4 0 0 1 1.473 1.594l.082.176c.18.418.262.873.305 1.395.048.589.048 1.32.048 2.243zm-10 4.668h4.002c.944 0 1.612 0 2.135-.043.514-.042.829-.122 1.076-.248l.184-.103c.418-.256.758-.624.982-1.063l.086-.2c.077-.217.13-.49.162-.876.043-.523.043-1.19.043-2.135V8.663c0-.944 0-1.612-.043-2.135-.032-.386-.085-.659-.162-.876l-.086-.2a2.67 2.67 0 0 0-.982-1.063l-.184-.103c-.247-.126-.562-.206-1.076-.248-.523-.043-1.19-.043-2.135-.043H8.164L8.165 4z" />
    </svg>
  );
}

// ChatGPT's collapsed-rail recent-chat mark: a single filled bubble outline
// with a low, rounded tail rather than Lucide's narrower speech circle.
function recentChatsIcon({ size = 20, ...props }: CustomIconProps) {
  return (
    <svg
      {...props}
      data-icon="recent-chats"
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M16.835 10c0-3.51-3.024-6.418-6.835-6.418S3.165 6.49 3.165 10c0 1.414.567 2.35 1.282 3.765.087.171.111.367.07.555l-.327 1.469 1.59-.412.145-.024a.8.8 0 0 1 .287.028l.136.051.459.212c1.062.472 2.06.775 3.193.775 3.811 0 6.835-2.91 6.835-6.42m1.33 0c0 4.314-3.692 7.749-8.165 7.749-1.52 0-2.804-.453-4.06-1.04l-2.204.572a.832.832 0 0 1-1.02-.986l.463-2.089C2.537 12.954 1.835 11.73 1.835 10 1.835 5.685 5.527 2.25 10 2.25S18.165 5.685 18.165 10" />
    </svg>
  );
}

export const Icons = {
  More: MoreHorizontal,
  Pen: PenLine,
  Pencil: Pencil,
  Trash: Trash2,
  NewChat: newChatIcon,
  PanelLeft: sidebarToggleIcon,
  LogOut: LogOut,
  Menu: Menu,
  Chats: recentChatsIcon,
  Chevron: ChevronDown,
  Copy: Copy,
  CopyFilled: copyFilledIcon,
  Code: codeIcon,
  Fullscreen: fullscreenIcon,
  Globe: Globe,
  HtmlPreview: htmlPreviewIcon,
  Paperclip: Paperclip,
  Plus: Plus,
  Loading: LoaderCircle,
  Check: Check,
  Refresh: RefreshCw,
  Share: Share2,
  Upload: Upload,
  ArrowUp: sendPromptIcon,
  Mic: Mic,
  Play: playIcon,
  Stop: Square,
  Close: X,
};
