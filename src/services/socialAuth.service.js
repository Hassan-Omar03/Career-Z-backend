const crypto=require('crypto');
const jwt=require('jsonwebtoken');
const client=require('openid-client');
const AppError=require('../utils/AppError');
const PROVIDERS=['google','facebook','apple','microsoft'];
const hash=value=>crypto.createHash('sha256').update(String(value)).digest('hex');
const random=()=>crypto.randomBytes(32).toString('base64url');
function settings(provider){
 if(!PROVIDERS.includes(provider))throw new AppError('Unsupported sign-in provider.',404);
 const prefix=provider.toUpperCase();
 const id=process.env[prefix+'_CLIENT_ID'];let secret=process.env[prefix+'_CLIENT_SECRET'];
 if(provider==='apple'&&!secret&&process.env.APPLE_PRIVATE_KEY&&process.env.APPLE_TEAM_ID&&process.env.APPLE_KEY_ID&&id){secret=jwt.sign({},process.env.APPLE_PRIVATE_KEY.replace(/\\n/g,'\n'),{algorithm:'ES256',keyid:process.env.APPLE_KEY_ID,issuer:process.env.APPLE_TEAM_ID,subject:id,audience:'https://appleid.apple.com',expiresIn:'5m'});}
 const tenant=process.env.MICROSOFT_TENANT_ID;
 const base=(process.env.OAUTH_SERVER_URL||process.env.SERVER_URL||'http://localhost:5000').replace(/\/$/,'');
 const redirectUri=base+'/api/auth/social/'+provider+'/callback';
 const ready=Boolean(id&&secret&&(provider!=='microsoft'||/^[0-9a-f-]{36}$/i.test(tenant||''))&&(provider!=='apple'||base.startsWith('https://'))&&(provider!=='facebook'||/^v\d+\.\d+$/.test(process.env.FACEBOOK_GRAPH_VERSION||'')));
 return {id,secret,tenant,redirectUri,ready};
}
function availability(){return PROVIDERS.map(provider=>({provider,enabled:settings(provider).ready}));}
async function configuration(provider,s){
 if(!s.ready)throw new AppError(provider[0].toUpperCase()+provider.slice(1)+' sign-in is not configured yet. Please use email/password for now.',503);
 if(provider==='facebook'){const version=process.env.FACEBOOK_GRAPH_VERSION;return new client.Configuration({issuer:'https://www.facebook.com',authorization_endpoint:'https://www.facebook.com/'+version+'/dialog/oauth',token_endpoint:'https://graph.facebook.com/'+version+'/oauth/access_token'},s.id,s.secret);}
 if(provider==='microsoft'){const issuer='https://login.microsoftonline.com/'+s.tenant+'/v2.0';return new client.Configuration({issuer,authorization_endpoint:'https://login.microsoftonline.com/'+s.tenant+'/oauth2/v2.0/authorize',token_endpoint:'https://login.microsoftonline.com/'+s.tenant+'/oauth2/v2.0/token',jwks_uri:'https://login.microsoftonline.com/'+s.tenant+'/discovery/v2.0/keys'},s.id,s.secret);}
 return client.discovery(new URL(provider==='google'?'https://accounts.google.com':'https://appleid.apple.com'),s.id,s.secret);
}
async function authorization(provider,s,flow){const config=await configuration(provider,s);const params={redirect_uri:s.redirectUri,response_type:'code',scope:provider==='facebook'?'public_profile email':'openid email profile',state:flow.state,code_challenge:await client.calculatePKCECodeChallenge(flow.verifier),code_challenge_method:'S256'};
 if(provider!=='facebook')params.nonce=flow.nonce;
 if(provider==='apple'){params.scope='openid email name';params.response_mode='form_post';}
 return client.buildAuthorizationUrl(config,params).href;
}
async function resolveProfile(provider,s,flow,req){const config=await configuration(provider,s);const params=req.method==='POST'?req.body:req.query;
 const callback=new URL(flow.redirectUri);for(const key of ['code','state','iss','error','error_description'])if(typeof params[key]==='string')callback.searchParams.set(key,params[key]);
 const checks={expectedState:params.state,pkceCodeVerifier:flow.verifier};if(provider!=='facebook'){checks.expectedNonce=flow.nonce;checks.idTokenExpected=true;}
 const tokens=await client.authorizationCodeGrant(config,callback,checks);
 if(provider==='facebook'){
  const url=new URL('https://graph.facebook.com/'+process.env.FACEBOOK_GRAPH_VERSION+'/me');url.searchParams.set('fields','id,name,email');url.searchParams.set('appsecret_proof',crypto.createHmac('sha256',s.secret).update(tokens.access_token).digest('hex'));
  const response=await fetch(url,{headers:{Authorization:'Bearer '+tokens.access_token},signal:AbortSignal.timeout(10000)});if(!response.ok)throw new AppError('Facebook profile could not be verified.',401);const profile=await response.json();return {subject:profile.id,email:profile.email,name:profile.name};
 }
 const claims=tokens.claims();if(!claims?.sub)throw new AppError('Provider identity could not be verified.',401);
 if(provider==='google'&&claims.email_verified!==true)throw new AppError('Verify your Google email before signing in.',401);
 return {subject:claims.sub,email:claims.email,name:claims.name||''};
}
module.exports={PROVIDERS,hash,random,settings,availability,authorization,resolveProfile};
