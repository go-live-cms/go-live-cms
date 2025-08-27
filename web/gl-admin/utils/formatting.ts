export function formatDate(isoString: string): string {
  const date = new Date(isoString);
  const month = date.toLocaleString('en-US', { month: 'long' });
  const day = date.getDate();
  const year = date.getFullYear();
  return `${month} ${day}, ${year}`;
}

export function formatTime(isoString: string): string {
  const date = new Date(isoString);
  return date.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  }).replace(/AM|PM/, (m) => m.toLowerCase());
}

export function formatDateTime(isoString: string): string {
  const date = new Date(isoString);
  // Format: Month Day, Year\nHH:mm am/pm
  const options: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  };
  // e.g. "July 27, 2025, 09:28 PM"
  const formatted = date.toLocaleString('en-US', options);
  // Split date and time, and add a line break
  const [datePart, timePart, ...rest] = formatted.split(', ');
  // If timePart is undefined, fallback to formatted
  if (!timePart) return formatted;
  // timePart is like "09:28 PM", convert to lowercase am/pm
  const time = timePart.replace(/AM|PM/, (m) => m.toLowerCase());
  return `${datePart}, ${date.getFullYear()}\n${time}`;
}

export function formatFullDate(isoString: string): string {
  const date = new Date(isoString);
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatRelativeDay(isoString: string): string {
  const inputDate = new Date(isoString);
  const now = new Date();

  // Zero out the time for both dates to compare only the date part
  const utcInput = Date.UTC(inputDate.getFullYear(), inputDate.getMonth(), inputDate.getDate());
  const utcNow = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());

  const diffDays = Math.round((utcInput - utcNow) / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return "today";
  if (diffDays === -1) return "yesterday";
  if (diffDays === 1) return "tomorrow";
  if (diffDays < 0) return `${Math.abs(diffDays)} day${Math.abs(diffDays) === 1 ? "" : "s"} ago`;
  return `${diffDays} day${diffDays === 1 ? "" : "s"} in the future`;
}

export function formatUserName(fullName: string): string {
    const parts = fullName.trim().split(" ");
    if (parts.length === 1) return parts[0];
    return `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`;
}

export function getInitials(name: string): string {
    const parts = name.trim().split(" ");
    if (parts.length === 0) return "";
    if (parts.length === 1) return parts[0][0].toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function capitalize(str: string | null) {
    if (!str) return "";
    return str.charAt(0).toUpperCase() + str.slice(1);
}