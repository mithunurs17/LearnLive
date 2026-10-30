import {defineConfig,loadEnv} from 'vite';import react from '@vitejs/plugin-react';
export default defineConfig(async({mode})=>{
  const env={...loadEnv(mode,process.cwd(),''),...process.env};
  const plugins=[react()];
  if(env.VITE_HTTPS==='true'){const {default:basicSsl}=await import('@vitejs/plugin-basic-ssl');plugins.push(basicSsl())}
  return{plugins,server:{proxy:{'/api':{target:env.API_PROXY||'http://localhost:4000',changeOrigin:true}}}};
});