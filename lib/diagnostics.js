const names=new Set(['Error','TypeError','RangeError','ReferenceError','SyntaxError','EvalError','URIError','AggregateError','TimeoutError','ProtocolError','TargetCloseError','UnknownError']);
const codes=new Set(['AUTH','DISCONNECT','NETWORK','ETIMEDOUT','ECONNRESET','ECONNREFUSED','ENETUNREACH','ENETDOWN','EHOSTUNREACH','ENOTFOUND','EAI_AGAIN','EPIPE','ERR_NETWORK','ERR_CONNECTION_CLOSED','ERR_CONNECTION_RESET','ERR_CONNECTION_TIMED_OUT']);
export function operationDiagnostic({error,state,elapsedMs,connection={}}){
  return {timestamp:new Date().toISOString(),accountId:state.accountId,host:state.host,tier:`T${state.tierIndex}`,phase:state.phase,
    errorName:names.has(error?.name)?error.name:'UnknownError',errorCode:codes.has(error?.code)?error.code:null,
    elapsedMs:Number.isFinite(elapsedMs)&&elapsedMs>=0?elapsedMs:null,
    browserConnected:typeof connection?.browserConnected==='boolean'?connection.browserConnected:null,
    pageClosed:typeof connection?.pageClosed==='boolean'?connection.pageClosed:null};
}
