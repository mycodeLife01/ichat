import { useState, useCallback } from 'react';
import { useDesignActions } from '../runtime/context';
export function useAuthSession(){
 const {services,user,setUser}=useDesignActions(); const [isSubmitting,setSubmitting]=useState(false);
 async function login(body:{identifier:string;password:string}){setSubmitting(true);try{setUser(await services.authApi.login(body))}finally{setSubmitting(false)}}
 async function register(body:{username:string;nickname:string;email:string;password:string}){setSubmitting(true);try{setUser(await services.authApi.register(body))}finally{setSubmitting(false)}}
 const refreshUser=useCallback(async()=>{const next={...await services.authApi.me(),email_verified:true};setUser(next);return next},[services,setUser]);
 return {user,isAuthenticated:!!user,isSubmitting,bootstrapped:true,login,register,logout:async()=>setUser(null),refreshUser};
}
