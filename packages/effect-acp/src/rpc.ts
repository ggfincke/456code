// packages/effect-acp/src/rpc.ts
// initialize rpc

import * as Schema from 'effect/Schema'
import * as Rpc from 'effect/unstable/rpc/Rpc'
import * as RpcGroup from 'effect/unstable/rpc/RpcGroup'

import * as AcpSchema from './_generated/schema.gen.ts'
import { AGENT_METHODS, CLIENT_METHODS } from './_generated/meta.gen.ts'
import * as ProviderExtensions from './provider-extensions.ts'

const NewSessionResponse = Schema.Struct({
  ...AcpSchema.NewSessionResponse.fields,
  ...ProviderExtensions.SessionModelsExtension.fields,
})
const LoadSessionResponse = Schema.Struct({
  ...AcpSchema.LoadSessionResponse.fields,
  ...ProviderExtensions.SessionModelsExtension.fields,
})
const ResumeSessionResponse = Schema.Struct({
  ...AcpSchema.ResumeSessionResponse.fields,
  ...ProviderExtensions.SessionModelsExtension.fields,
})

export const InitializeRpc = Rpc.make(AGENT_METHODS.initialize, {
  payload: AcpSchema.InitializeRequest,
  success: AcpSchema.InitializeResponse,
  error: AcpSchema.Error,
})

export const AuthenticateRpc = Rpc.make(AGENT_METHODS.authenticate, {
  payload: AcpSchema.AuthenticateRequest,
  success: AcpSchema.AuthenticateResponse,
  error: AcpSchema.Error,
})

export const LogoutRpc = Rpc.make(AGENT_METHODS.logout, {
  payload: AcpSchema.LogoutRequest,
  success: AcpSchema.LogoutResponse,
  error: AcpSchema.Error,
})

export const NewSessionRpc = Rpc.make(AGENT_METHODS.session_new, {
  payload: AcpSchema.NewSessionRequest,
  success: NewSessionResponse,
  error: AcpSchema.Error,
})

export const LoadSessionRpc = Rpc.make(AGENT_METHODS.session_load, {
  payload: AcpSchema.LoadSessionRequest,
  success: LoadSessionResponse,
  error: AcpSchema.Error,
})

export const ListSessionsRpc = Rpc.make(AGENT_METHODS.session_list, {
  payload: AcpSchema.ListSessionsRequest,
  success: AcpSchema.ListSessionsResponse,
  error: AcpSchema.Error,
})

export const ForkSessionRpc = Rpc.make(AGENT_METHODS.session_fork, {
  payload: AcpSchema.ForkSessionRequest,
  success: AcpSchema.ForkSessionResponse,
  error: AcpSchema.Error,
})

export const ResumeSessionRpc = Rpc.make(AGENT_METHODS.session_resume, {
  payload: AcpSchema.ResumeSessionRequest,
  success: ResumeSessionResponse,
  error: AcpSchema.Error,
})

export const CloseSessionRpc = Rpc.make(AGENT_METHODS.session_close, {
  payload: AcpSchema.CloseSessionRequest,
  success: AcpSchema.CloseSessionResponse,
  error: AcpSchema.Error,
})

export const PromptRpc = Rpc.make(AGENT_METHODS.session_prompt, {
  payload: AcpSchema.PromptRequest,
  success: AcpSchema.PromptResponse,
  error: AcpSchema.Error,
})

export const SetSessionModeRpc = Rpc.make(AGENT_METHODS.session_set_mode, {
  payload: AcpSchema.SetSessionModeRequest,
  success: AcpSchema.SetSessionModeResponse,
  error: AcpSchema.Error,
})

export const SetSessionConfigOptionRpc = Rpc.make(AGENT_METHODS.session_set_config_option, {
  payload: AcpSchema.SetSessionConfigOptionRequest,
  success: AcpSchema.SetSessionConfigOptionResponse,
  error: AcpSchema.Error,
})

export const ReadTextFileRpc = Rpc.make(CLIENT_METHODS.fs_read_text_file, {
  payload: AcpSchema.ReadTextFileRequest,
  success: AcpSchema.ReadTextFileResponse,
  error: AcpSchema.Error,
})

export const WriteTextFileRpc = Rpc.make(CLIENT_METHODS.fs_write_text_file, {
  payload: AcpSchema.WriteTextFileRequest,
  success: AcpSchema.WriteTextFileResponse,
  error: AcpSchema.Error,
})

export const RequestPermissionRpc = Rpc.make(CLIENT_METHODS.session_request_permission, {
  payload: AcpSchema.RequestPermissionRequest,
  success: AcpSchema.RequestPermissionResponse,
  error: AcpSchema.Error,
})

export const CreateElicitationRpc = Rpc.make(CLIENT_METHODS.elicitation_create, {
  payload: AcpSchema.CreateElicitationRequest,
  success: AcpSchema.CreateElicitationResponse,
  error: AcpSchema.Error,
})

export const CreateTerminalRpc = Rpc.make(CLIENT_METHODS.terminal_create, {
  payload: AcpSchema.CreateTerminalRequest,
  success: AcpSchema.CreateTerminalResponse,
  error: AcpSchema.Error,
})

export const TerminalOutputRpc = Rpc.make(CLIENT_METHODS.terminal_output, {
  payload: AcpSchema.TerminalOutputRequest,
  success: AcpSchema.TerminalOutputResponse,
  error: AcpSchema.Error,
})

export const ReleaseTerminalRpc = Rpc.make(CLIENT_METHODS.terminal_release, {
  payload: AcpSchema.ReleaseTerminalRequest,
  success: AcpSchema.ReleaseTerminalResponse,
  error: AcpSchema.Error,
})

export const WaitForTerminalExitRpc = Rpc.make(CLIENT_METHODS.terminal_wait_for_exit, {
  payload: AcpSchema.WaitForTerminalExitRequest,
  success: AcpSchema.WaitForTerminalExitResponse,
  error: AcpSchema.Error,
})

export const KillTerminalRpc = Rpc.make(CLIENT_METHODS.terminal_kill, {
  payload: AcpSchema.KillTerminalRequest,
  success: AcpSchema.KillTerminalResponse,
  error: AcpSchema.Error,
})

export const AgentRpcs = RpcGroup.make(
  InitializeRpc,
  AuthenticateRpc,
  LogoutRpc,
  NewSessionRpc,
  LoadSessionRpc,
  ListSessionsRpc,
  ForkSessionRpc,
  ResumeSessionRpc,
  CloseSessionRpc,
  PromptRpc,
  SetSessionModeRpc,
  SetSessionConfigOptionRpc,
)

export const ClientRpcs = RpcGroup.make(
  ReadTextFileRpc,
  WriteTextFileRpc,
  RequestPermissionRpc,
  CreateElicitationRpc,
  CreateTerminalRpc,
  TerminalOutputRpc,
  ReleaseTerminalRpc,
  WaitForTerminalExitRpc,
  KillTerminalRpc,
)
