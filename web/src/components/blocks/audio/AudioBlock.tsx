import React from "react"
import type { BlockComponentProps } from "../types"
import { PlayableBlock } from "../video/VideoBlock"

/** Audio (#423): `figure.audio-block > audio` with the browser's controls; see `PlayableBlock`. */
const AudioBlock: React.FC<BlockComponentProps> = (props) => <PlayableBlock {...props} kind="audio" />

export default AudioBlock